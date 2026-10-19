---
title: "Hurry Up and Wait: The Life of an RL Sandbox (Part 1)"
date: 2026-10-19
summary: "How I built a gVisor sandbox service for agent RL."
bib: hurry-up-and-wait-part-1.bib
series: Hurry Up and Wait
part: 1
---

**TL;DR:** I built a gVisor sandbox service for agentic RL, and then spent a long time fitting more sandboxes onto the same VMs while keeping them isolated and their rewards correct. Almost every RL task has its own image, and agents spend much of each rollout waiting for the model. This post covers how the service deals with both:

- starting a sandbox in about a second by reading its image lazily;
- fitting the image corpus on a single disk by deduplicating file content;
- failing reads with an error when the reader daemon dies or a chunk is corrupt, since silent zeros would turn into wrong rewards;
- pausing each sandbox at every model wait and moving its pages to swap under memory pressure;
- detecting those waits from packet headers on the worker;
- prefetching a sandbox's memory before it resumes.

---

Over the past few months I have been scaling up post-training at [Danish Foundation Models](https://www.foundationmodels.dk/). I've been building the service as a single developer during those months, with a lot of help from AI coding assistants, and this is my attempt at documenting the process and the current outcomes. If there are any particularly egregious AI-generated statements in this post, please reach out to me and I will fix them. I do care and every sentence has been reviewed manually!

## 1. Introduction

Every rollout in agentic RL needs a sandbox. The policy model writes code, the sandbox runs it, and tests inside the sandbox compute the reward. We run these sandboxes on a fixed set of cloud VMs. Any memory, disk or time a sandbox uses for something other than the agent's work means fewer rollouts on those VMs.

Code from a model in training can do anything, including crash the kernel it runs on. Each sandbox therefore needs a kernel boundary of its own. A microVM would give each sandbox its own kernel, but microVMs need `/dev/kvm` and our VMs have none. Each sandbox runs under gVisor instead. The tests decide the reward, so whenever a sandbox reads a file, it has to get the right bytes or an error.

Within those limits, most of the cost comes from images and from waiting. Each sandbox needs the image of its task, and for most RL environments every task has a different image. If the worker pulls the whole image before starting the sandbox, the agent waits for gigabytes of files, although its first commands read only a few percent of them. Between tool calls, agents wait for the model, leaving the sandbox idle but holding live state.

Sandboxes are also used for serverless functions, CI jobs and development environments. The usual sandbox optimizations, such as warm pools and writing idle sandboxes to disk, come from these workloads. A serverless platform normally runs few images many times, and most requests go to warm containers or cached images. CI runs a few images per repository and keeps the CPU busy for minutes, so its throughput depends more on build speed than on startup. A development sandbox stays idle for hours while its user is away, so writing its memory to disk during longer idles makes sense.

Neither optimization fits an RL rollout. With an image per task, warm pools do not apply. The agent waits for the model for seconds to minutes at a time, which is long enough for idle memory to add up across many sandboxes but too short to justify writing that memory to disk just to read it back again.

Our setup shifts the balance further. The VMs come from research grants, and their number is limited. To run more rollouts, we need to fit more sandboxes on each VM. We also train asynchronously: a new rollout starts as soon as another ends, so the trainer keeps receiving rollouts while slow ones finish.

On our workers, memory runs out before CPU does, so memory limits how many sandboxes fit. By Little's law [@little1961], the number of live sandboxes equals the rate at which rollouts finish times how long each one lasts. The trainer needs rollouts at a fixed rate. At that rate, every second of overhead in a rollout means more sandboxes alive at the same time, and more memory in use. Most of that memory goes unused while the agent waits for the model. The service therefore aims to cut both: the seconds of overhead in each rollout, and the memory a waiting sandbox holds.

A slow rollout also delays its whole group. The trainer accepts a group only if it lags behind the current policy by at most K versions. In the figure, a slow sandbox create holds group B back past that limit, and the trainer drops it.

![Asynchronous training with K = 3, and synchronous training below for comparison. A slow sandbox create holds up group B (red) past the off-policy limit, so B is dropped, while the other highlighted group, A, trains. Hatching marks sandbox overhead.](hurry-up-and-wait-part-1/02-async-timeline.svg)

The sandbox service runs on a gateway VM and a set of worker VMs. Each sandbox depends on three paths, numbered in the figure below:

1. The orchestrator sends commands to the gateway, and the gateway passes them to the node daemon on a worker. The node daemon runs the sandboxes under gVisor, and the gateway keeps the state of each sandbox in PostgreSQL.
2. The agent calls the model through a relay on the gateway VM.
3. Workers fetch image bytes from a store node in front of object storage.

![The platform around a sandbox, and the three paths it depends on: commands through the gateway (1), model calls through the relay (2) and image bytes from the store node (3).](hurry-up-and-wait-part-1/01-platform.svg)

The rest of the post covers my solutions to the issues I encountered while building our sandbox service. Section 2 covers isolation: gVisor runs on these VMs but slows down syscall-heavy tools. Section 3 is about images: the node daemon reads them lazily from a deduplicated store, which moves fetches into the middle of the agent's run. Section 4 is about memory: pausing each sandbox at model waits fits more sandboxes into less active memory. Section 5 lists the trade-offs and what comes next.

## 2. Isolation under gVisor

An agent in a training run executes whatever the policy model writes, sometimes as root, and ordinary agent work can be enough to crash a kernel. DSec [@dsec] reported losing hosts this way. A recursive `grep` from `/` crashed the host kernel when it read `/proc/kpagecgroup`. An agent that used `XFS_IOC_SWAPEXT` to get around file permissions corrupted the XFS metadata. With containers, every sandbox on a worker shares the host kernel, so a crash like this takes down the whole worker.

The usual answer is a microVM per sandbox. Each sandbox gets its own guest kernel, and the host handles only the VM's exits. DSec and Kimi K3's AgentEnv [@kimik3] both moved their sandboxes into VMs after agents crashed kernels. A microVM needs `/dev/kvm` on the host, which means bare metal, nested virtualization or a host kernel built for it. Our VMs have none of these, and I can't change their kernel.

gVisor requires none of that. Its kernel, the Sentry, is a Go program that implements Linux system calls in user space and runs as an ordinary process on the host. On gVisor's systrap platform, the host kernel traps each of the guest's syscalls and hands it to the Sentry. The Sentry in turn makes a small set of host syscalls, and a seccomp filter[^seccomp] blocks all others.

|  | Containers (runc) | gVisor | MicroVM (Firecracker) |
| --- | --- | --- | --- |
| Handles a guest syscall | The host kernel | The Sentry | A guest kernel |
| Needs on the host | Any Linux | Any Linux with seccomp | `/dev/kvm` |
| A bug in that code takes down | The host | One sandbox | One VM |

### Compatibility

Since the Sentry reimplements Linux, I expected many tasks to break under it, but few did. When I first ran Prime Intellect's environments under gVisor, most of them set up without changes. The failures had ordinary causes, such as a gated dataset or a missing image, and none came from a missing syscall. A few tasks hit bugs in gVisor's handling of POSIX default ACLs and the umask. After I fixed those, the tasks passed as they do under runc. Tasks needing systemd, mounts, devices or kernel modules fail when their sandbox is created.

Tencent [@tencent-gvisor] compared gVisor with runc on paired RL task runs and found pass rates about 1.7 points lower. Part of the gap came from races in the tasks' own code, and slower syscalls make such races more likely.

### Overhead

The Sentry itself uses little memory: an idle one added about 16 MiB to its sandbox's cgroup[^cgroup]. Image reads go through the host's page cache[^pagecache], and sandboxes on the same image share the cached pages.

The Sentry costs more in time than in memory, since each guest syscall is a round trip to it. When I timed common commands, warm commands took about twice their native time. Syscall-heavy tools slow down the most: `import torch` alone makes about 26,000 syscalls, according to Modal [@modal-snapshots]. Compute-bound tools slow down much less. Slower tools make rollouts longer, and longer rollouts keep more sandboxes alive (Section 1).

### Tasks needing a full VM

gVisor runs most tasks, including Docker inside a sandbox. Docker needs extra runsc flags, though, and those flags loosen the sandbox's network isolation. Some tasks still need a full VM, for example to load kernel modules, use devices or run systemd. A microVM gives them a real kernel. DSec [@dsec] runs microVMs alongside its containers. MicroVMs also let the sandboxes of a group start from a single prepared VM and share its memory copy-on-write. gVisor can't share memory that way across sandboxes.

## 3. Getting the image

The orchestrator sends the rollouts of a group to a worker. That worker rarely has the task's image yet, and the group's sandboxes can start only once it does.

### 3.1 Whole-image pulls and lazy reads

The simplest option is for the node daemon to pull the image with Docker, unpack it and start the sandbox. In a pull test on 40 SWE-bench images, the median sandbox waited about 90 s for its first successful create. A group is complete only when its slowest rollout finishes. A slow create delays the whole group, and its rollouts are staler by the time the trainer gets them.

Most of the pulled bytes were never read: Docker moved 30 to 50 MB for each MB read by a rollout's first commands. Instead, the node daemon mounts each image lazily, as an EROFS[^erofs] filesystem. Behind the mount, a reader daemon fetches each piece of a file the first time a sandbox reads it. The sandbox can start as soon as the worker has the image's metadata. The first create went from about a minute and a half to about a second:

| Pull test, 40 SWE-bench images | p50 | p95 |
| --- | --: | --: |
| Docker pull | 92 s | 211 s |
| Lazily loaded EROFS | 1.3 s | 2.4 s |

The reader daemon still fetches every byte the sandbox reads, during the agent's first commands. In a cold `pip --version`, these fetches took most of the 1.1 s. When the store node is slow, the running sandbox waits for it (Section 3.3).

Whole-image pulls stay the simpler choice when a worker runs few distinct images, or when sandboxes read most of the bytes in their image.

The store node also has to hold every image on its 2 TB disk. Stored as OCI layers plus their EROFS conversions, the prebuilt images alone took about 3 TB.

### 3.2 Sharing bytes across independently built images

Many images in a corpus start from the same base, so storing images by container layer should keep a single copy of each shared layer.

Unfortunately, the layers rarely match. Two ScaleSWE images with nearly 99% of their file bytes in common shared no bytes at all when stored by layer chain. OCI identifies a layer by the hash of its tar stream. The stream includes the order of the files, their mtimes and their tar headers, and these rarely match between two independent builds.

For two builds to share bytes, the store has to identify data by file contents alone. We therefore split each file into **chunks** and identify each chunk by the hash of its bytes. The converter looks up each chunk of an OCI image in the chunk index. It compresses only the new chunks and appends them to pack files in S3.

An image is then its metadata plus a list of its chunks. The converter writes both in RAFS v6, the image format of the Nydus project [@nydus]. RAFS v6 uses the EROFS on-disk format, so the host kernel can mount it. The reader daemon behind the mount (Section 3.1) is the Nydus daemon, nydusd.

![Storage per image family on the 181-image sample, as OCI layers plus EROFS against the chunk store.](hurry-up-and-wait-part-1/05-chunk-store.svg)

Families built from a single source, such as TMax and ScaleSWE, shrank about 20 times. The prebuilt corpus as a whole shrank about 9 times, from 3 TB to 331 GB. It fits on the store node's disk.

The converter cuts each file into chunks at fixed offsets, starting from the beginning of the file. Many dedup tools place chunk boundaries based on the bytes instead, so that inserting data into the middle of a file changes only the chunks near the insertion. Container images rarely change that way. A package install writes or replaces whole files, and two identical files give identical chunks at fixed offsets too. I chose fixed offsets because they are simpler.

> **An aside on Nydus's own chunk dictionary.** Before the chunk index existed, I tried Nydus's own chunk dictionary. It silently wrote wrong bytes into some of an image's files, and then stopped partway at a RAFS v6 limit. I built the chunk index to replace Nydus's dictionary after that trial.

Early on, first imports took more than twice as long after conversion. The converter built images with `mkfs.erofs -T0` from erofs-utils [@erofs-utils]. That flag sets every mtime to 0. Python checks `.pyc` files against their source's mtime, so on first import it recompiled every one. The converter now keeps build-time mtimes, and since chunk identities come from file contents alone, the chunks stayed the same.

### 3.3 Making the reader daemon fail closed

Suppose the daemon crashes while a sandbox imports a library, and the kernel completes the read with zeros instead of an error. Python rejects source code containing null bytes, the dynamic loader rejects a zeroed shared library, and the import fails with a confusing error. The orchestrator masks rollouts that fail with a sandbox error, which leaves them out of training. Since no daemon reported a failure, the rollout gets reward 0 as if the agent had broken something. A zeroed data file, such as a test fixture, is worse, since the tests then run to completion on wrong input.

The Linux kernel can hand a page-cache miss to a userspace daemon in several ways. Linux's network block device (NBD) [@nbd] forwards block reads over a socket to a userspace server. We compared four mechanisms, mainly on whether a sandbox's reads fail or return zeros when the daemon dies:

| Mechanism | Daemon restart | Daemon death |
| --- | --- | --- |
| FUSE | Takeover if a supervisor holds the `/dev/fuse` fd | `ENOTCONN` |
| EROFS over cachefiles on-demand [@cachefiles] (fscache) | Plain restart broke every mount (`ENOBUFS`) | Mounts unusable |
| fanotify `FAN_PRE_ACCESS` | A new listener can register | **Open**: pending events answered ALLOW |
| NBD + kernel EROFS | None in nydusd | **EIO** in 45 ms |

With fanotify, the sandbox read zeros after the listener died. FUSE returned an error. But with FUSE, the kernel sends the daemon a request for every uncached path lookup, and a single Python import looks up dozens of directories. With fscache, a plain restart of the daemon broke every mount.

We use stock nydusd in NBD mode. NBD failed closed in the comparison: when nydusd died, the kernel's NBD driver failed the pending reads with EIO, an I/O error. nydusd exposes each RAFS v6 image as a block device, and the host kernel mounts that device as EROFS. The kernel then serves metadata from its own page cache, without a request to nydusd.

![The layers of a gVisor sandbox. Image reads come through nydusd and the shared host page cache, while guest writes stay in the Sentry.](hurry-up-and-wait-part-1/04-gvisor-layers.svg)

A live nydusd can still serve wrong bytes. For example, after a fault, S3, the store node or the chunk index might return the wrong part of a pack file. nydusd is the last process to handle the bytes before the kernel, so it checks each chunk against an expected digest. The gateway signs a root digest for each image with an Ed25519 key, and a chain of digests leads from that root down to the sha256 of each chunk. The node daemon checks the signature before it starts nydusd. On a mismatch, nydusd returns EIO, just as the kernel does when nydusd dies. The orchestrator masks the failed rollout either way. S3, the store node and the chunk index can therefore stay untrusted, and we can change any of them without revisiting integrity.

When the store node is slow, a read blocks until the fetch completes. Some GETs to our object storage stalled, often again on retry. nydusd therefore retries a fetch for up to 270 s. We set the kernel's NBD timeout above that, because each NBD timeout permanently closes one of the device's connections. A stalled fetch then adds to the agent's command time, and the sandbox holds its memory while it waits.

## 4. Waiting for the model

After each tool call, the agent sends the output to the model and waits for the next action. I'll assume model waits of 15 to 25 s, as in the load tests below. Real waits depend on the model, the length of its output and queueing at the inference servers. During a wait, the agent's processes do nothing, but the sandbox keeps its memory. In a production snapshot of real agents, a sandbox held about 0.54 GiB on average. The node daemon can leave that memory in place. It can also write the memory to disk and read it back before the agent continues. That frees RAM for other sandboxes but makes the turn take longer.

### 4.1 Keeping the memory or writing it out

The usual way to free an idle sandbox's memory is to hibernate it. gVisor writes the memory to disk and frees the RAM, and the node daemon reads the memory back before the sandbox continues. For a model wait, writing out a guest's memory and reading it back takes about as long as the wait itself, and the agent waits for the read before its next turn.

Gray's five-minute rule answers the same question for database pages: keep a page in RAM if it will be used again within about five minutes, and otherwise write it out and read it back when needed [@gray1987]. For a sandbox holding R bytes through a wait of $t_w$ seconds, where hibernating writes F bytes, the rule says to hibernate only when

$$t_w \, R > T \, F, \qquad T = 300\ \text{s}$$

Hibernating writes at least the guest's memory, which makes F at least R. The rule then says to hibernate only for waits longer than five minutes. File writes in the guest push that threshold higher, while model waits are more than ten times shorter.

I chose to keep waiting sandboxes in memory and pause them (Section 4.2). When the worker runs short of memory, the node daemon moves pages of paused sandboxes to swap. The kernel then writes out only the coldest pages and reads back only the pages the guest uses again, while hibernating writes all of F before it frees anything. The node daemon hibernates a sandbox only as a last resort, for example when swap is full.

### 4.2 Pausing, reclaiming and thawing a sandbox

gVisor pauses and hibernates a sandbox by itself, because the Sentry holds all of the guest's kernel state in its own memory. `runsc pause` stops the agent's processes, and the guest's memory stays in RAM. A pause and a resume each took under 10 ms at the median. Pausing alone frees no memory, but it makes swapping cheap. A paused guest uses no CPU and accesses none of its pages, so any pages the node daemon moves to swap stay there until the thaw. The Sentry keeps running the whole time, so its network stack can still receive the model's answer (Section 4.3).

When the worker runs low on memory, the node daemon writes to the `memory.reclaim` file of a paused sandbox's cgroup. The kernel then moves that sandbox's pages to swap on the worker's NVMe. Model waits have similar lengths, so the sandbox that has waited longest is the likeliest to wake next. The node daemon therefore reclaims the most recently paused sandboxes first.

DSec [@dsec] freezes a container's cgroup before reclaiming it. Reclaim doesn't need the freeze, since the kernel reclaims from a cgroup whether or not its tasks run. For gVisor, the freeze would also stop the Sentry, but the Sentry has to keep running to acknowledge the model's answer.

If the guest faults its pages back in from swap after it resumes, the thaw is slow, because each fault blocks a guest thread while the kernel reads a few pages around it. Instead, the node daemon reads the pages back before it resumes the guest. gVisor keeps all guest memory in a single file. I patched gVisor to create that file on the host, so the node daemon can read it directly with eight threads. In a prefetch test, reading the memory file this way was 4 to 6 times faster than letting the guest fault the same pages back in.

### 4.3 Detecting model waits from packet headers

To pause at every model wait, the node daemon has to notice when each model call starts and when its answer arrives. The agent's model calls already pass through the relay, so our first design let the relay drive each pause. When a call went out, the relay asked the gateway to pause the sandbox. Before delivering the answer, it asked the gateway to thaw it. Both the relay and the gateway recorded each step in PostgreSQL. That design put the gateway and PostgreSQL on the path of every model call. With a slow or restarting gateway, every agent in the fleet would wait at its next turn.

The worker's kernel handles both the agent's request and the model's answer, as packets on the relay connection. The node daemon now makes the pause decision itself, from the headers of those packets. An nftables rule copies the headers of each packet on the relay connection to an NFLOG group, and the node daemon reads the copies over netlink. On each turn:

- The agent finishes a command and sends the output to the relay in plain HTTP on the private network.
- When 50 ms pass after the request with no reply, the node daemon checks the sandbox's CPU use over those 50 ms. If the sandbox used almost no CPU in that time, the node daemon pauses it.
- When the copies include the first data packet of the answer, the node daemon thaws the sandbox. gVisor's network stack keeps running while the guest is paused, so it has already acknowledged and buffered that packet.
- The agent reads the answer and continues.

The node daemon leaves a sandbox running while a command sent through the gateway runs in it. If a client of the gateway, such as the orchestrator, polled a sandbox's logs this way every few seconds, the sandbox would keep running through every model wait.

You might expect a paused sandbox to break TCP. When I tried delaying a 1 MB answer by 2 s, it arrived without retransmissions or timeouts. On a production canary worker, the node daemon handled every model wait without the gateway, and answers got to the agent slightly faster.

Anyways, the relay keeps a fallback for hibernated sandboxes. With each answer, it writes a wake-up request for the sandbox to PostgreSQL, due in 5 seconds. The relay deletes the request as soon as the sandbox's network stack has acknowledged the whole answer. A hibernated sandbox has no running network stack to acknowledge anything. Its request stays in PostgreSQL, and after 5 seconds the gateway wakes it.

![Pausing a sandbox through the relay and gateway (before), and from packet headers in the node daemon (after).](hurry-up-and-wait-part-1/07-relay-before-after.svg)

When I tried TLS on the relay connection, detection broke. Right after the handshake, a TLS 1.3 server sends session tickets, and the node daemon thawed the sandbox on those instead of on the answer. I kept the relay connection in plaintext, since its traffic stays on the private network and each rollout has its own relay token.

### 4.4 Pausing against hibernating under memory pressure

In a load test, 140 synthetic agents on one worker went through eight model waits each. Together, they used more memory than the worker had. In one arm, the node daemon paused the sandboxes, reclaimed them to swap and prefetched at the thaw. In the other, it kept waiting sandboxes resident and hibernated them whenever the worker ran short of memory, even for waits it would otherwise keep paused.

![Wake time per model wait in the 140-agent pressure trial, pausing against hibernating.](hurry-up-and-wait-part-1/08-wake-times.svg)

At p95, a wake took 14.2 s in the hibernating arm and 0.13 s in the pausing arm. The median wake was about the same in both arms. The waits that ended hibernated made up the gap at p95.

By Little's law (Section 1), the slower wakes of the hibernating arm would keep an estimated 48 more sandboxes live in our training runs. Together, those sandboxes would hold about 26 GiB.

![Extra live sandboxes, and the memory they hold, caused by slow wakes and by slower tools.](hurry-up-and-wait-part-1/03-overhead-memory.svg)

Hibernation is the better choice for waits longer than about five minutes (Section 4.1). If model calls came with an estimate of their length, the node daemon could hibernate the long ones right away.

## 5. Trade-offs and next steps

Lazy images and pausing cut the two longest delays in a sandbox's life. On SWE-bench images, the median first create went from 92 s to 1.3 s, and under memory pressure, the p95 wake went from 14.2 s to 0.13 s.

The design comes with costs:

- nydusd's NBD mode is marked experimental upstream.
- When a per-image daemon dies, every sandbox reading that image fails and has to start over.
- With readahead, nydusd fetched two to four times the bytes the sandbox read, which puts more load on the store node.
- Header detection needs the relay connection in plaintext.
- If a client of the gateway polled a sandbox's logs every few seconds, the sandbox would keep running through every model wait (Section 4.3).

MicroVMs suit environments needing a full VM, for example to load kernel modules or run systemd (Section 2). For everything else, gVisor has been really nice to work with. Whole-image pulls suit workers with few distinct images (Section 3), and hibernation suits waits of many minutes (Section 4.4).

Beyond the warm-command timings in Section 2, I haven't yet measured how much real agent tools slow down under gVisor. By the Little's law estimate at the end of Section 4.4, that slowdown holds more memory than slow wakes did. It's the next thing I'll measure.

I'm hoping to write a part 2 of this, about scaling the service up to thousands of sandboxes at once, where a bunch of new issues come up, and about creating and curating environments for our RL training.

[^seccomp]: seccomp is a kernel filter listing the system calls a process may make.
[^cgroup]: A cgroup is the kernel's unit for counting and limiting the resources of a group of processes.
[^pagecache]: The page cache is the kernel's in-memory copy of recently read files.
[^erofs]: EROFS is a compressed, read-only filesystem in the Linux kernel.
