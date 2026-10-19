---
title: "Hurry Up and Wait: The Life of an RL Sandbox (Part 1)"
date: 2026-10-19
summary: "How I built a gVisor sandbox service for agent RL."
bib: hurry-up-and-wait-part-1.bib
series: Hurry Up and Wait
part: 1
---

**TL;DR:** I built a sandbox service for agent RL, custom made for our grant-funded cloud VMs, based on gVisor. We train asynchronously, so the trainer keeps working while a slow sandbox finishes its rollout, but that sandbox stays alive longer and keeps memory in use. In a fleet like ours, each second a sandbox spends on overhead means about 3 more live sandboxes holding memory, and each new rollout waits about 90 s for a whole-image pull before its sandbox starts. The service therefore cuts that overhead in three places. First, sandboxes read their images lazily from a deduplicated chunk store, which takes several times less space than OCI images and cuts the median wait for a sandbox's first create from 92 s to 1.3 s. Second, sandboxes pause at every model wait, meaning that their processes stop while their memory stays in RAM, resuming in milliseconds. Hibernating a sandbox instead, by writing its memory to disk, frees the RAM but takes seconds to read back. Pausing cuts the p95 wake under memory pressure from 14.2 s to 0.13 s. Third, the node daemon detects those waits from packet headers on the worker, so pausing and resuming a sandbox needs no round trip through the gateway and PostgreSQL. This post follows a single sandbox through the service.

---

Over the past few months I have been scaling up post-training at [Danish Foundation Models](https://www.foundationmodels.dk/). In agentic RL, an agent attempts a task in each rollout, editing files and running tests, so every rollout needs a machine of its own: a sandbox. During a training run, thousands of sandboxes can be alive at once. For these runs we needed a sandbox service built on the virtual machines in our academic cloud environment, which we get resources on through research grants. Every decision described in this post is made around that setup. Many labs would have different requirements, but perhaps some teams building on rented VMs can recognize our constraints. I've been building the service as a single developer during those months, with a lot of help from AI coding assistants, and this is my attempt at documenting the process and the current outcomes. If there are any particularly egregious AI-generated statements in this post, please reach out to me and I will fix them. I do care and every sentence has been reviewed manually!

We train asynchronously, as is standard now, so new rollouts start while slow ones are still running. Keeping the trainer supplied then takes more sandboxes at once, each holding memory. We also eventually discard rollouts that finish too late, together with the other rollouts in the slow group (Section 2).

We made the main design decisions under three constraints:

- Our VMs lack `/dev/kvm`, the device needed by microVM runtimes such as Firecracker. Each sandbox instead runs under gVisor, a kernel in user space serving the guest's system calls (Section 3).
- Our tasks at the time of writing reference more than 66k image names, too many for warm sandboxes per image. Instead, workers fetch each image's bytes on first read, from a chunk store holding each distinct chunk once. On 181 images, the chunk store took about 8.6 times less space than OCI layers plus their EROFS conversions. On 40 SWE-bench images, the median wait for a sandbox's first create dropped from 92 s with whole-image pulls to 1.3 s (Section 4).
- Sandboxes spend most of their lives waiting for the model. We pause each sandbox at every model wait and leave its memory in place. We hibernate a sandbox, writing its memory to disk, only when the worker is short of memory and swap is full. In a load test with 140 agents on one worker, sandboxes woke at a p95 of 0.13 s, against 14.2 s when they were hibernated whenever memory ran short (Section 5).

Sections 1 and 2 explain why we built our own service and what sandbox overhead costs, and Sections 3 to 5 follow a single sandbox through the service.

## 1. Why we built our own sandbox service

There are many commercial services selling sandboxing as a service. To name a few: Modal, E2B, Daytona. I built ours because RL rollouts differ from the workloads best served by these services (to some extent, everyone is obviously building towards being able to run many agents, but not necessarily for a training setup) and because our current grants give us VMs rather than cash.

### 1.1 Rollouts and other sandbox workloads

Here is how RL rollouts compare with other workloads that run in sandboxes:

| Workload | Distinct images | Lifetime | Wall time spent on | Arrival pattern | Optimization target |
| --- | --- | --- | --- | --- | --- |
| Serverless | Few, each invoked often | Milliseconds to minutes | Executing the function | Independent requests | Cold-start latency |
| CI | Few per repository | Minutes to hours | CPU-bound build and test | Commits, mostly uncorrelated | Job throughput |
| Hosted dev sandbox | An image per user or project | Hours to days | Waiting for a human | Interactive | Resume latency, idle cost |
| RL rollout | 10^4 to 10^6 per corpus | Minutes | Waiting for the policy model | Continuous, in groups of identical tasks; bursts at ramp-up and recovery | Rollouts per second within the off-policy limit; memory per rollout |

In the first three workloads, a runtime starts a few images many times and can hide the startup time behind a warm pool of ready sandboxes or cached images. Our corpus at the time of writing contains about 130k tasks over 66k image names, too many for a warm pool per image. (The tasks also have problems of their own, which lead to reward hacking among other issues. I hope to cover environments in a separate post soon.) A sandbox also reads only a small share of its image's bytes: a few percent for its first commands and about 30% for slim images (Section 2.2). Instead of pulling whole images, workers fetch each piece of an image when a sandbox first reads it (Section 4).

In the wall-time column, an RL rollout waits many times for a policy model shared by the whole fleet, for up to about 98% of a sandbox's lifetime according to the Kimi K3 report [@kimik3]. During each wait, a sandbox keeps its memory resident, about 0.54 GiB on average for our real coding agents. A thousand such sandboxes hold about 540 GiB, the entire usable memory of three of our workers, while using little CPU. So our workers run out of memory long before they run out of CPU. The node daemon, the program managing a worker's sandboxes, pauses them during model waits and writes their memory to disk only when the worker is short of memory and swap is full (Section 5).

In the arrival column, the rollouts of a group start together on the same task, and the trainer can use a group only after its slowest rollout finishes. If a group is still running K trainer steps after its dispatch, with K a limit we set, we drop it as too stale to train on (Section 2.1).

### 1.2 The cost of hosted sandboxes

The table shows what a fleet like ours, about 1,000 live sandboxes each allocated 1 vCPU and 2 GiB, would cost at the vendors' published rates on 2026-10-14. On average, a sandbox uses 0.54 GiB and an estimated 0.1 vCPU.

| Option | Charged for | Per hour | Per day |
| --- | --- | --: | --: |
| [Modal Sandboxes](https://modal.com/pricing) | Greater of requested and used | $119 allocated, $31 at its usage floor | $2,860 or $740 |
| [E2B](https://e2b.dev/pricing) | Allocated resources | $83 | $1,990 |
| [Daytona](https://www.daytona.io/pricing) | Allocated resources | $83 | $1,990 |
| Six [AWS m7i.16xlarge](https://aws.amazon.com/ec2/pricing/on-demand/) VMs, on demand | Whole VMs | $19 | $460 |
| Six [Hetzner CCX63](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) VMs | Whole VMs | $10 | $230 |

The AWS rates are on-demand prices in us-east-1, and the VM rows leave out storage, egress and operations. Modal and E2B cap a sandbox's lifetime at 24 hours, and Modal offers academic credits of up to $10,000.

The last two rows show that six VMs of roughly our workers' size would run the same thousand sandboxes for about 4 to 12 times less than the hosted services charge for allocated resources. A hosted service would also cost us about $2,000 per day of training from a small budget, while our grants already cover the VMs. So we run our sandboxes on those VMs and pack them densely, since each extra sandbox on a worker lowers the cost per rollout.

Our VMs also lack `/dev/kvm`, Linux's device for hardware virtualization, so Firecracker (so trendy) and the other microVM runtimes behind most hosted services fail to start on them. The provider gives us the VMs as they are: I can't change their kernel or turn on nested virtualization, but I can run any ordinary process on them. gVisor runs its kernel as such a process. That is why every sandbox in this post runs under gVisor (Section 3).

### 1.3 The platform at a glance

The figure shows the platform around the sandboxes and the three main paths each sandbox depends on. On path 1, the orchestrator sends commands through the gateway to create sandboxes, start the agent harness in each and delete them when the rollout ends. On path 2, the harness sends the agent's model calls to the relay, where the inference side picks them up, and runs the tool calls the policy model returns inside the sandbox. On path 3, nydusd fetches each image chunk from the store node when a sandbox first reads it. In this post, Section 3 opens the sandbox itself, Section 4 follows the image bytes and Section 5 the model calls.

![The platform around a sandbox, and the three paths it depends on: commands through the gateway (1), model calls through the relay (2) and image bytes from the store node (3).](hurry-up-and-wait-part-1/01-platform.svg)

I modelled the sandbox lifecycle on Kimi K3's AgentEnv and most of the rest on DeepSeek's DSec, adapting both from Firecracker and QEMU VMs to gVisor. The main components are:

- **Gateways.** Gateway processes choose a worker for each new sandbox and record the sandbox's route in PostgreSQL. A gateway also signs each image's root, a small record of digests for checking fetched chunks (Section 4).
- **Workers.** Each worker is a 64-vCPU, 192 GB cloud VM, with about 176 GiB usable. Its node daemon creates, pauses and destroys the worker's sandboxes by running a patched build of gVisor's `runsc` directly (Section 3).
- **Store node.** The store node, another VM, serves image chunks to the workers from its full copy of the chunk store, which holds each distinct chunk once, addressed by its digest. The chunk store's permanent copy is in object storage (Section 4).
- **Relay.** Sandboxes call the policy model through the relay, a service on the gateway VM (Section 5).

For a waiting sandbox, we'll use three terms (Section 5):

- **Pause.** The node daemon stops the sandbox's guest tasks with `runsc pause` and leaves its memory resident. The sandbox resumes in about 10 ms.
- **Capture.** gVisor writes the sandbox's kernel state and memory, including the guest's writes to its root filesystem, to a file on local disk.
- **Hibernate.** The node daemon has gVisor capture the sandbox's state, then stops the sandbox to free its memory. When the model's answer arrives, gVisor restores the sandbox from the capture in seconds.

## 2. What sandbox overhead costs

Under asynchronous training, a slow sandbox costs us in two ways: we keep more rollouts in progress to maintain the rate of finished rollouts, each holding memory once its sandbox starts, and we drop a group whose slowest rollout finishes too long after dispatch.

The inputs to the models below are measurements from our deployment.

### 2.1 Asynchronous training

In synchronous RL, the trainer and most inference servers stay idle while the last rollouts of a batch finish. PipelineRL [@piche2025pipelinerl] removes that wait by running generation and training at the same time. When the trainer produces new weights, the inference servers pause briefly to load them and then continue their current sequences. A single rollout can then carry tokens from several policy versions. The trainer corrects for the mix with importance weights, scaling each token's update by the ratio of its probability under the current policy to its probability under the older sampling policy.

Our trainer is built on prime-rl [@primeintellect-asyncrl], which also implements the async design. Its orchestrator, the process dispatching rollouts, batches continuously (Section 2.1.3 of the INTELLECT-3 technical report [@intellect3]): it keeps up to C rollouts in progress and starts a new one as soon as any rollout ends, so the inference servers keep generating while a group's last rollouts finish. A controller moves C between a minimum and a maximum we set, raising it while the inference servers' KV cache has room and lowering it as the cache fills. Sandboxes start and end with their rollouts:

1. The G rollouts of a group run the same task from the same initial state and start within seconds of each other. This post uses G = 8.
2. A group completes when its slowest rollout finishes. Each sandbox ends as soon as its rollout finishes.

The PipelineRL authors report that common RL algorithms perform worse on tokens from a policy several versions old. We bound this staleness with the `max_off_policy_steps` setting, written K in this post, which dates all rollouts of a group from the policy version current at the group's dispatch. The orchestrator cancels a group once the group can no longer finish within K steps, and drops a finished group if more than K steps have passed since its dispatch when the trainer takes the next batch. Either way, we lose the group's tokens, along with the GPU time used to generate them.

This post uses K = 10, an illustrative value. The default is 8, the value used for INTELLECT-3.

In the figure below, each slot gets a new rollout as soon as its rollout ends, and inference pauses only to load new weights. Groups A and B start at version 1, and their rollouts keep running across weight updates. A's last rollout ends under version 2, and A trains in step 3, two versions after its dispatch and within K. A slow sandbox create delays one of B's rollouts. B is still running when step 4 takes its batch, the last batch B could enter within K versions, so the orchestrator cancels it and discards B's finished rollouts too.

![Asynchronous training with K = 3, and synchronous training below for comparison. A slow sandbox create holds up group B (red) past the off-policy limit, so B is dropped, while the other highlighted group, A, trains. Hatching marks sandbox overhead.](hurry-up-and-wait-part-1/02-async-timeline.svg)

In synchronous training, slots sit empty and the trainer idles until the batch's slowest rollout finishes.

### 2.2 The workload in numbers

The table lists published values for rollout fleets next to ours. The read-fraction and duty-cycle rows matter most here: they are the reason for the lazy image reads of Section 4 and the pausing of Section 5.

| Quantity | Published values | This deployment |
| --- | --- | --- |
| Distinct images | 10k to 1M per corpus (Section 1.1) | 66k image names over 130k tasks |
| Read fraction | DSec [@dsec]: 4.2% to 13.3% of 4 to 12 GB images read at runtime | Fetched on 64 images: 2.3% for first commands, about 30% for slim images |
| Duty cycle (share of life spent in tools) | Kimi K3: inference up to about 98% of a sandbox's lifetime. Aries [@aries]: CPU-idle more than 80% of the time, tool execution 13% to 48% of end-to-end trajectory latency | 51% of sandboxes paused in a model wait at peak, with a fake model, so tools and overhead took at most about half of each sandbox's time. Heavily model- and task-dependent |
| Live sandboxes, L | DSec: up to 32K per job | About 1,000 |
| Rollout lifetime, W | None published | 300 s assumed below |
| Resident memory per sandbox | DSec: about 470 MB per container at its demonstrated point (estimated) | A production snapshot of 174 sandboxes running OpenCode and Pi agents, memory still growing: 0.54 GiB average, p99 1.08 GiB. Whole rollouts likely average more |

For the duty cycle, we used a fake model that answers each call in 5 to 30 s, with no queue. Real calls also queue at the inference servers, and long reasoning steps can take more than 30 s, so I expect real agents to spend even more of their lives waiting for the model.

### 2.3 Overhead keeps more sandboxes alive

In our fleet, about 3.3 rollouts finish every second. If each of them spends 92 s longer than it needs to, about 300 more rollouts are in progress at any moment. Little's law [@little1961] states this in general: the average number of items in a system is their arrival rate times their average time in it.

$$L = \lambda W$$

For the fleet, L is the number of live sandboxes and λ the rollout completion rate. W is a rollout's wall time in its sandbox, from create to release: the create, including any wait for the image, then for each turn a model wait, tool calls and a wake, the time for the node daemon to resume a sandbox paused during the wait (Section 5). The sampler, which picks tasks, calls `ensure` before dispatch to build any missing image (Section 4), so only the remaining wait counts. The sandbox overhead is the part of W added by the sandbox runtime: the create, the wakes and any slowdown in the tool times.

Because the orchestrator starts a new rollout as soon as one ends, a slow rollout keeps its slot and sandbox busy for longer, while its groupmates' slots go to new rollouts as soon as they finish. The number of rollouts in progress is then the completion rate times the average rollout time, and nearly all of them have a live sandbox. Only those still waiting for their image don't.

When sandbox overhead makes rollouts longer, a fixed cap on rollouts in progress means fewer of them finish per second. The orchestrator's controller usually raises the cap instead. A rollout waiting on its sandbox generates no tokens, which leaves room in the inference servers' KV cache, and the controller fills that room with extra rollouts, each with a sandbox holding memory. The rate holds until the cap reaches the maximum we set or the workers run out of memory. I also assume that the trainer is compute-bound. If it waits for data, each of its steps takes longer by about the mean overhead. Ideally this is balanced so inference throughput matches trainer throughput.

For a delay after the sandbox starts, such as a slow wake or a stalled fetch, the extra rollouts in progress times 0.54 GiB, the average we measured earlier, is an estimate of the memory they hold. A rollout waiting for an image pull has no sandbox yet and holds almost none. A pull costs the group time from its window (Section 2.4).

Our fleet gives the numbers that Sections 3 to 5 reuse:

1. In our runs, about L = 1,000 sandboxes are live on six workers, each with about 176 GiB of usable memory (Section 1.3). Without sandbox overhead, a rollout lasts W0 = 300 s, an assumed value.
2. The trainer then consumes λ = L/W0, about 3.3 rollouts per second.
3. To hold that rate, the orchestrator needs about 3.3 more rollouts in progress for each second of overhead per rollout.
4. A whole-image pull lasting 92 s, the median in our pull test on 40 SWE-bench images (Section 4.1), would add about 300 rollouts in progress, none of them with a sandbox yet. A lazy fetch at its median of 1.3 s would add about 4.

These estimates run low, because they use the median pull time, while Little's law needs the mean, which is higher for long-tailed pull times. The figure applies the same arithmetic to the overheads that keep a sandbox alive, the wakes after model waits and slower tools, and shows the memory the extra sandboxes hold. For the wakes, it uses the mean wake in the 140-agent pressure trial (Section 5.5).

![Extra live sandboxes, and the memory they hold, caused by slow wakes and by slower tools.](hurry-up-and-wait-part-1/03-overhead-memory.svg)

With hibernation under memory pressure, slow wakes after model waits kept about 50 extra sandboxes alive, holding about 26 GiB, against about 2 with pausing (Section 5.5). If gVisor made every tool call twice as slow, a rollout whose tools take 13% to 48% of its 300 s would last 39 to 144 s longer, and the extra sandboxes would hold 70 to 260 GiB. Shorter rollouts raise the rate and with it every bar: at 2-minute rollouts, each bar would be 2.5 times longer. The controller adds these sandboxes only while the workers have memory for them. Once memory runs out, the overhead costs rollouts per second instead.

A higher cap keeps up the rate, but each rollout still lasts as long as before. If a slow rollout lasts long enough, the orchestrator drops its whole group as too stale (Section 2.4).

Creates arrive at about the rate rollouts finish, 3.3 per second, with a group's eight creates back to back and usually sharing an image. That is about half a sandbox per second on each of the six workers, far below a node daemon's maximum create rate. At the start of a run, the orchestrator grows its pool slowly, admitting at most a tenth of its cap every 5 s, but after a fault it replaces each failed rollout at once, while the affected groups' windows are already running. Refilling the fleet within 30 s takes about 10 times the steady create rate. If we lose one of the six workers, the other five have to recreate its roughly 167 sandboxes, which fit in the 880 GiB they have between them, and the store node gets the same burst of image reads.

### 2.4 Slow rollouts and dropped groups

A group finishes with its slowest rollout, and the orchestrator drops it if that rollout ends more than about K trainer steps after the group's dispatch. If the trainer takes a step every 60 s (t\_step, assumed), then with K = 10 a group has a window of about 600 s, K t\_step, from its dispatch. The usable window is somewhat shorter, because a group may start partway through a trainer step and may wait for the next batch after it finishes.

An average 300 s rollout finishes about 5 trainer steps after its dispatch, half of K. But whether its group fits depends on the slowest of its eight rollouts. The tail of rollout lifetimes matters more than their mean: for 99% of groups to fit, about 99.9% of rollouts have to. With lognormal lifetimes averaging 300 s and no sandbox overhead, an estimated 0.1% of groups would miss the window at a coefficient of variation (standard deviation over mean) of 0.2, 5% at 0.3 and 30% at 0.5. Agent rollouts with long turn caps can spread more than that.

A 92 s pull takes up about 15% of the window, while a lazy fetch takes well under 1%. A rare slow sandbox seldom costs its group. If each sandbox hits a slow path with probability 0.1%, eight sandboxes per group put a slow one in an estimated 0.8% of groups, and the orchestrator drops such a group only if the slow rollout also runs past the window, which rarely happens when most groups finish well inside it. The slow rollout still costs time in progress: fewer rollouts per second with a fixed cap, or more sandboxes in memory with a raised cap.

I assume that most groups in our runs finish well inside the window, as they would if the standard deviation of rollout lifetimes were about 20% of their mean. If many finish close to it instead, the orchestrator drops most groups containing a stalled sandbox, and the count of groups dropped for staleness rises. The spread of rollout lifetimes is therefore the first measurement to take on our runs (Section 6).

That estimate assumes that sandboxes slow down independently. When the store node or a single worker VM slows down, though, every group with a sandbox waiting on it falls behind at the same time. At ramp-up and recovery, those groups can make up most of the fleet.

The trainer can use only the rollouts entering a batch within the off-policy limit. Their number per second is the goodput, and sandbox overhead reduces it in three ways:

1. Overhead, including the wake after every model wait, keeps each rollout in progress longer, so fewer rollouts finish per second at a given cap.
2. Overhead pushes some groups' slowest rollouts past the window, and the orchestrator drops those groups.
3. Sandbox errors lose single rollouts, because we mask a failed rollout's completion. An integration that drops the whole group instead loses G times as many.

## 3. The isolation boundary

Every sandbox runs under gVisor, whose kernel runs in user space as an ordinary process on the worker. Guest programs run slower under gVisor mainly because each system call (syscall) has to be handed off to that kernel. While a sandbox is idle, the Sentry adds about 16 MiB to its memory, an estimated 3% of a real agent's average, plus the gofer process, which that figure leaves out. The larger cost is time: I measured that warm commands took about twice their native time under gVisor, and if every tool slowed down that much, the extra live sandboxes would hold 70 to 260 GiB (Section 3.3).

On a worker in the middle of a training run, every live sandbox runs code from the policy model, unreviewed and sometimes as root. Most of that code edits files or runs tests, but agents doing such ordinary work have still crashed host kernels (Section 3.1), taking every other sandbox on the worker down with them. A sandbox has to keep its agent away from the other agents' files and processes, and often also from the internet (Section 3.5).

### 3.1 Containers and microVMs

Containers are the usual starting point, because they add almost no overhead. Under runc, the host kernel serves every guest syscall after checking it against a seccomp profile, a kernel filter listing the syscalls allowed for a process. Containers started from the same image layer share its file pages in the host page cache, the kernel's in-memory copy of recently read file data.

Unfortunately, when a guest triggers a kernel bug, the host kernel can crash, killing every other sandbox on the worker. DSec reported losing hosts to ordinary agent actions like these:

- A recursive `grep` from `/` read `/proc/kpagecgroup` and crashed the kernel.
- An agent working around file access controls with `XFS_IOC_SWAPEXT` corrupted XFS metadata.

DSec responded by running its containers inside QEMU VMs. According to the Kimi K3 report, AgentEnv moved from containers to microVMs after agents caused kernel panics and deadlocks.

Most hosted sandbox services run each sandbox in a microVM under a VMM (a virtual machine monitor, such as Firecracker). The microVM's guest kernel serves the guest's syscalls, and the host kernel handles only the guest's exits from the VM. In exchange, the host has to provide `/dev/kvm`, available only on bare metal, under nested virtualization or with a PVM host kernel. AgentEnv's PVM mode [@agentenv] uses a PVM host kernel on cloud VMs.

On hosts with `/dev/kvm`, a microVM is the better choice when tasks need a real kernel, for example to run Docker or systemd or to create mounts inside the sandbox. MicroVMs also help when a group's G sandboxes should start from a prepared sandbox and share its memory copy-on-write, because gVisor lacks a copy-on-write fork across sandboxes.

Our VMs offer none of the ways to get `/dev/kvm`. They aren't bare metal, the provider doesn't expose nested virtualization, and a PVM host kernel would have to replace the kernel of the VM itself, which we can't change. The sandboxes therefore need a kernel that runs between the guest and the host as an ordinary process.

### 3.2 Choosing gVisor

gVisor's kernel is the Sentry, a Go program that implements Linux's system calls in user space. Every guest syscall goes to the Sentry.

Because the Sentry holds all guest kernel state in its own memory, gVisor can capture a whole sandbox [@gvisor-checkpoint] without CRIU, the usual tool for checkpointing Linux processes. Guest memory consists of pages of a host file charged to the sandbox's cgroup (the kernel's unit for accounting and limiting a group of processes), so the host kernel can reclaim those pages through ordinary cgroup interfaces.

The three runtimes differ in what sits above the boundary:

|  | Containers (runc) | User-space kernel (gVisor) | MicroVM (Firecracker) |
| --- | --- | --- | --- |
| Handler of a guest syscall | The host kernel, behind a seccomp profile | The Sentry; the host kernel gets only the Sentry's syscalls, from an allowlist | A guest kernel; the host gets VM exits and virtio requests |
| File page cache | Host page cache, shared by every container on the layer | Host page cache, shared through host file descriptors (directfs) | Every guest's page cache, plus the host's unless DAX or `O_DIRECT` bypasses it |
| Snapshot contents | A process tree rebuilt from host kernel objects (CRIU) | The Sentry's kernel objects plus its memory file; no CRIU, no VMM | Device state, guest memory and disk |
| Host requirements | Any Linux | Any Linux with seccomp; no `/dev/kvm` on the systrap platform | `/dev/kvm`: bare metal, nested virtualization or a PVM host kernel |
| Idle floor per sandbox | Near zero | 16 MiB cgroup charge for the Sentry; the gofer process is extra and not counted | A VMM plus a booted guest kernel and its page cache |
| Effect of a kernel bug | Hits the host | Hits the Sentry; the host is exposed through the seccomp allowlists of the Sentry and gofer, and through kernel paths used by every process | Hits the guest; the host is exposed through KVM and the VMM |

Sandboxes run under gVisor on its systrap platform (its mode for intercepting syscalls without ptrace or KVM), inside the provider VM. Tasks that need systemd, mounts, devices or kernel modules fail at create rather than run behind a weaker boundary.

Since the Sentry reimplements Linux, you might expect many tasks to break under gVisor, but few did. Tencent [@tencent-gvisor] compared gVisor with runc over 74,379 paired RL task runs and found compatibility gaps worth about 1.7 points of pass rate, plus races made more likely by slower syscalls. In a first compatibility run of Prime Intellect's environments under gVisor, the few setup failures had ordinary causes, such as a gated dataset. None of them came from a missing syscall. After I fixed the runtime's handling of POSIX default ACLs and the umask (these seem to be actual gVisor bugs), the affected tasks passed as they do under runc.

I chose gVisor because it was what our VMs could run, but several of its properties suit RL sandboxes well, and the rest of this post builds on them. Reads from the image go through the worker's page cache, so sandboxes on the same image share its pages, as containers do (Section 3.4). An idle sandbox adds little memory, where a microVM boots a whole guest kernel with its own page cache. Since the Sentry holds all of a sandbox's state, gVisor can also pause a sandbox, or write its memory and kernel state to disk, without a VM monitor (Section 5).

gVisor also adds work on the host, outside the Sentry. For each create, runsc copies the host mount namespace while holding a global kernel lock, so I expect the lock to limit a worker's create rate.

### 3.3 The layers of a gVisor sandbox

Five parts of a gVisor sandbox matter for its cost: systrap, the memory file, the gofer with directfs, netstack and the rootfs overlay. With our settings, the Sentry handles the guest's syscalls, network traffic and file writes itself. Only file reads reach the host, through a page cache that all sandboxes on the worker share.

The figure shows a sandbox's layers: the guest at the top, the host processes in the middle and the host kernel at the bottom. An image read starts at the store node and reaches the guest through nydusd, the shared page cache and directfs. A guest write stays in the Sentry's rootfs overlay, whose pages are backed by a file in the host's upper directory.

![The layers of a gVisor sandbox. Image reads come through nydusd and the shared host page cache, while guest writes stay in the Sentry.](hurry-up-and-wait-part-1/04-gvisor-layers.svg)

**Systrap.** Every guest syscall has to go to the Sentry instead of the host kernel. Systrap [@systrap] delivers it there without ptrace or KVM:

1. Each guest address space runs in a host stub process, with a stub thread for each guest thread. The stub's seccomp filter returns `SECCOMP_RET_TRAP`, so the host kernel raises SIGSYS on the thread instead of running the call.
2. The stub's signal handler writes the registers into memory shared with the Sentry and waits. Both sides spin on that memory before sleeping on a futex, so on idle CPUs a round trip can complete without a context switch.
3. On x86\_64, the Sentry rewrites hot syscall sites into a jump to a stub trampoline. Later calls from a rewritten site skip the signal.

Under systrap, the guest thread hands each syscall off to the Sentry, another user-space process. gVisor's KVM platform skips the hand-off, but only on hosts with `/dev/kvm`.

To size the hand-off, I timed commands in a sandbox and natively on a 48-vCPU VM, with directfs on. Warm commands took about twice the native time. In a cold `pip --version`, gVisor added about 0.2 s of the 1.1 s total, and most of the rest went to fetching the image (Section 4.4).

Now assume every tool call slows down as much as the warm commands did. Tools take 13% to 48% of a rollout's 300 s in the published range (Section 2.2). Doubling their time stretches a rollout to between 339 and 444 s. Holding about 3.3 rollouts/s then takes an estimated 1,130 to 1,480 live sandboxes instead of 1,000. At 0.54 GiB each, the extra sandboxes hold at most about 70 to 260 GiB, up to about one and a half workers' usable memory.

Even at 444 s, the average rollout finishes inside the 600 s off-policy window, although a group with a slow member may not (Section 2.4). Compute-bound tools slow down less than the warm commands did, while syscall-dense tools can slow down more: Modal reports [@modal-snapshots] that `import torch` alone makes 26,000 syscalls. So the doubling is only a rough guide. Still, tool slowdown is the largest overhead in the figure in Section 2.3, and nothing in this post reduces it. The next step is to measure how much real tools slow down under gVisor.

**The memory file.** All guest anonymous memory consists of pages of a single file, the application memory file. Upstream gVisor makes it a memfd, a file with no path in any host filesystem, which the kernel frees once the Sentry and its stubs exit. A stock checkpoint therefore copies every page out. I changed the runtime to let the node daemon create the file on a host tmpfs and donate it to the Sentry. The file then stays on the tmpfs after the Sentry exits, so the node daemon can treat guest memory as an ordinary host file:

- In a capture, gVisor serializes the kernel objects and copies only the file's allocated extents to disk.
- To thaw a paused sandbox, the node daemon reads the file from the host (Section 5).

**The gofer and directfs.** The Sentry runs in an empty mount namespace, so it opens host files only through the gofer, a helper process controlling the guest's access to them. Without directfs, every open, stat and read becomes an RPC to the gofer, with a round trip per operation. With directfs [@directfs] (`--directfs`, on by default), the gofer instead donates host file descriptors to the Sentry over its socket. The Sentry then resolves and reads files itself, with `*at` syscalls relative to those descriptors. Guest reads go through the host page cache, as a runc container's reads do (Section 3.4).

**Netstack.** With `--network=sandbox`, the Sentry runs its own TCP/IP stack, netstack. It exchanges Ethernet frames with the host over a packet socket on the sandbox's veth (a virtual Ethernet pair linking the sandbox's network namespace to the host), so the host kernel handles only frames. Because the Sentry keeps TCP state in its own memory, every capture includes the sandbox's open connections. Netstack keeps running while `runsc pause` stops the guest's tasks, so the node daemon can pause a sandbox through a model wait with its connection to the model still open (Section 5.2).

**Guest writes and the rootfs overlay.** Guest reads use shared host pages, but each sandbox's writes have to go somewhere private to it. Under its default, `--overlay2=root:self`, gVisor keeps them inside the Sentry, in an overlay over the rootfs [@gvisor-filesystem]:

- The lower layer is the host tree served by the gofer.
- The upper layer is a Sentry tmpfs, with its pages backed by a single host file, `.gvisor.filestore.<id>`, inside the upper directory of the host overlay.

The Sentry handles creates, renames and writes itself, without any host syscall. When I checked, a guest write showed up only in the filestore. The host kernel holds the filestore's data in page cache, outside the memory file, and can reclaim it like other file pages. Until the kernel writes the data back to disk, it charges the pages to the sandbox's memory cgroup. gVisor writes the filestore out again in every capture, since the filestore is part of the Sentry's state (Section 5.1).

With `--overlay2=none`, gVisor puts writes in the host upper directory, where host processes can read them without a checkpoint. Each guest write then becomes a host syscall. The host filesystem also has to parse file names chosen by the guest. I kept `root:self` to keep the guest's writes and file names away from the host kernel. The node daemon reads job status files from host bind mounts instead.

### 3.4 Sharing image pages between sandboxes

Since each sandbox has its own Sentry and gofer, each could keep a private copy of its image's hot pages. Image memory would then grow with L, the number of live sandboxes.

To check, I started 32 sandboxes on a Python data-science image. Each sandbox imported numpy, pandas and scipy. Host `MemAvailable`, the kernel's estimate of memory available without swapping, fell by about 47 MiB per sandbox, of which only 0.4 MiB was page cache. The rest was Sentry-private memory and guest anonymous memory, so the image's hot pages stayed shared. I measured the sharing with host-wide counters instead of per-process RSS, because the kernel counts a shared page in the RSS of every process mapping it.

You might also object that a host mount wastes memory, since gVisor can mount EROFS [@erofs], a read-only Linux filesystem image format, inside the Sentry. In the same setup, with EROFS mounted as the root inside the Sentry, host memory use fell from 47 to 29 MiB per sandbox. That saving is about 3% of a real agent's 0.54 GiB. gVisor's EROFS reader also rejects the chunk-based files in Nydus images (Section 4.3), so I kept the host mount.

Since directfs shares an image's pages whatever its format, I chose the format on other grounds (Section 4.3). The host page cache still grows with each distinct image on a worker.

### 3.5 Containment layers and guest privileges

Three layers lie outside the guest's control and count as containment:

1. the provider VM,
2. the host kernel, which the guest can use only through
   - the Sentry's and gofer's seccomp filters,
   - a network namespace with its firewall,
   - cgroup limits,
3. the Sentry.

Most tasks run without internet access, with the model relay as their only way out of the sandbox's network namespace. Their packages are installed when the image is built, before any agent runs, through a caching proxy on the store node that serves only allowlisted package mirrors. For tasks that do need the network, an allowlist of the domains or addresses they use is safer than open egress.

Many task images expect a VM-like Linux host, so training sandboxes run as the user the image sets, often root, with Docker's default capabilities instead of our stricter default. The sandboxes run without a user namespace or an extra OCI seccomp profile, relying on gVisor's own seccomp filters. The node daemon also guards the host interfaces exposed to a guest that may be root:

- **Sandboxes connecting to host services over IPv6.** With IPv6 enabled on the host end of its veth, a sandbox can connect over link-local addresses to host services listening on `[::]`, bypassing the firewall's IPv4-only `INPUT` drop. The node daemon therefore creates each sandbox's veth pair with IPv6 disabled on both ends.
- **Guest symlinks in host-visible directories.** A guest can plant symlinks in the bind mounts exposing guest state to the host. The node daemon opens each path there with `O_NOFOLLOW`, then checks `S_ISREG` and a size cap. When deciding whether to hibernate, the node daemon looks only at a fixed fingerprint of the job record, so nothing a guest writes there can keep its sandbox from being hibernated.

## 4. Getting the image

We store each distinct piece of file data in our images once, in a content-addressed store. On 181 of our images, that took about 8.6 times less space than OCI layers plus their EROFS conversions. Workers fetch a piece only when a sandbox first reads it, which cut the median wait for a sandbox's first create from 92 s to 1.3 s on 40 SWE-bench images. The bytes travel from S3 to the store node, then through nydusd into a host mount that the Sentry reads via directfs.

Say a group of eight rollouts is dispatched to a worker that doesn't have their task's image. If pulling the image takes about 90 s, the group has used 90 s of its off-policy window before any of its sandboxes starts (Section 2.4).

A worker rarely gets to reuse a pulled image, because RL corpora contain an image per task or per repository snapshot (Section 1.1):

| Corpus | Distinct images | Tasks or sandboxes | Notes |
| --- | --- | --- | --- |
| DSec, one production week | 11,266 bases and 102,171 workspaces (containers); 53,590 task disks (microVMs) | not stated |  |
| Kimi K3 | 1,505,678 | 51,219,741 sandboxes | About 34 sandboxes per image |
| SWE-smith | 128 repository images | 50k+ | Each task is a branch of a few images [@agentlightning] |
| This deployment | 66k names; about 8k prebuilt | 130k | About 58k recipe images built on first use |

Apart from SWE-smith, these corpora contain 10^4 to 10^6 images, with a few dozen sandboxes per image at most.

Most of our 66k names are recipe images: a prebuilt base image plus the remaining build steps of a task's Dockerfile. When the sampler picks a task, it calls the sandbox service's `ensure`, which builds a recipe image into the chunk store on its first use. If `ensure` is still running at dispatch, the group's rollouts wait for it as part of their W.

This puts three requirements on the store and its readers:

1. A sandbox has to start before most of its image's bytes arrive, since its first commands read only a few percent of them.
2. The corpus has to fit on the store node's 2 TB disk.
3. Every read has to return either the right bytes or an error, since a wrong byte would silently change the reward computed by the sandbox's tests.

### 4.1 Whole-image pulls and lazy reads

The simplest option is for the node daemon to pull the image with Docker, unpack it and start the sandbox. In a pull test on 40 SWE-bench images, the median sandbox waited about 90 s for its first successful create. At the p95 of 211 s, a rollout would start with more than a third of a 600 s window gone, leaving its group less room for a slow rollout later (Section 2.4).

Most of the pulled bytes are never read (Section 2.2): the pull moved 30 to 50 MB for each MB that a rollout's first commands read. DSec saw the same thing, with eager pulls in a large burst finishing about 1.7 times later than on-demand loading.

Instead, the node daemon mounts each image as a lazily loaded EROFS filesystem. Behind the mount, a reader daemon fetches each piece of a file the first time a sandbox reads it, and the sandbox can start as soon as the worker has the image's metadata. Here is the pull test again, with lazy loading:

| Pull test, 40 SWE-bench images | p50 | p95 |
| --- | --: | --: |
| Docker pull | 92 s | 211 s |
| Lazily loaded EROFS | 1.3 s | 2.4 s |

At p95, the wait dropped from over 200 s to under 3 s, roughly 90 times faster on these images. But the reader daemon now fetches the rest of the image while the sandbox runs, and a slow store node can make a running sandbox wait (Section 4.4).

Whole-image pulls remain the simpler choice when sandboxes read most of their image and each worker runs few distinct images.

The store node still has to hold every piece of every image. Stored as OCI layers plus their EROFS conversions, the 8,100 prebuilt images alone took about 3 TB, more than the store node's 2 TB disk.

### 4.2 Sharing bytes across independently built images

Many images in a corpus start from the same base, so storing images by container layer should keep a single copy of each shared layer.

Unfortunately, the layers rarely match. Two ScaleSWE images with nearly 99% of their file bytes in common shared no bytes at all when stored by layer chain. OCI identifies a layer by digests at several levels:

1. the diff ID, a hash of the uncompressed tar stream, including its entry order, mtimes and tar headers,
2. the blob digest, a hash of the compressor's output,
3. the chain ID, a hash over the layer and all of its parents.

Two independent builds of the same files rarely produce identical tar streams, so their layers get different digests at every level. Two builds of a block-device image such as overlaybd [@overlaybd], an ext4 filesystem fetched in blocks, differ in the same way, because ext4 places each file's blocks according to the order of earlier writes.

For two builds to share bytes, the store has to identify data by file contents alone, so we key it by **chunk**: a piece of a single file, identified by the hash of its bytes. For every file in an OCI image, the converter:

1. splits the file into pieces of at most 256 KiB, so every chunk stays inside a single file,
2. hashes each piece's uncompressed bytes with sha256 to get the chunk's identity,
3. skips the piece if the chunk index already lists its digest,
4. otherwise compresses the piece with zstd, appends it to a content-addressed pack file of at most 64 MiB in S3 and records the pack file and offset in the index.

We'll call the collection of chunks the chunk store.

The converter writes each image in RAFS v6, the EROFS-based format of the open-source Nydus project [@nydus], read by the Nydus daemon, nydusd. An image then consists of a bootstrap, the file holding all of the image's metadata, plus a chunk map listing its chunks. Content-defined chunking places chunk boundaries by the bytes themselves, so inserting data into a file changes only the chunks near the insertion. With fixed-size chunks, the same insertion shifts every later chunk, and none of them match any more. Images rarely change that way: a package install writes or replaces whole files, and the converter splits each file from its start, so identical files give identical chunks. I chose fixed-size chunks, the simpler of the two.

We use 256 KiB chunks to match the unit of the worker's chunk cache, at the cost of more requests when a large file is read cold. The chunk size barely changed the total, because in the 181-image sample most stored chunks were far smaller than 256 KiB anyway.

The comparison at the start of this section is a bit generous to the chunk store, since it counts each image twice, as OCI layers and as their EROFS conversion. A Nydus copy of the sample without dedup took about 3 times the space of the chunk store, so dedup across images accounts for a factor of about 3, and the change of format for the rest.

The savings varied widely by image family:

![Storage per image family on the 181-image sample, as OCI layers plus EROFS against the chunk store.](hurry-up-and-wait-part-1/05-chunk-store.svg)

Families built from a single source, such as TMax and ScaleSWE, shrank about 20 times, with each new image adding about 12 MB of unique chunks. The mixed SWE-smith/R2E/Lego/rebench family was the exception, at about 5 times and about 330 MB per new image. The prebuilt corpus shrank from 3 TB to 331 GB, well within the store node's disk.

A corpus of 100k images would add about 1.2 TB to the bytes shared by all images at the single-source families' 12 MB each, and about 4 TB, twice the store node's disk, at the prebuilt corpus's average of about 41 MB.

Our store stays well below both projections, because `ensure` builds recipe images only for sampled tasks, each adding about 5 to 15 MB after dedup. After later rebuilds and evals, the store node held about 0.39 TB.

> **An aside on Nydus's own chunk dictionary.** In a trial on a 181-image sample, run before the chunk index existed, Nydus stopped partway at a RAFS v6 limit, after silently writing wrong bytes into about 5% of a single image's files. Since then, I think every dedup layer is worth checking against its source, file by file.

Early on, first imports took more than twice as long after conversion. I discovered that, with `mkfs.erofs -T0`, the converter, built on erofs-utils [@erofs-utils], had set every mtime to 0, so on first import Python found every `.pyc` file out of date and recompiled them all. A first scientific package import took 3.7 s instead of 1.4 s and wrote about 26 MB into the Sentry's filestore, which gVisor writes out again in every capture (Section 3.3). The converter now keeps build-time mtimes. That changes only the bootstrap, since chunk identities come from file contents alone.

### 4.3 Choosing a lazy format under gVisor

The lazy format has to keep all metadata on the worker and share bytes across independently built images. A sandbox reads metadata on every `stat`, `open` and path walk, and a Python import walks dozens of directories on the module search path before it opens a single file. With the default EROFS layout, the converter placed the metadata among the file data, and a `find / -xdev` on that layout made over a hundred remote reads. After the converter packed the metadata into a single zone with `mkfs.erofs --MZ`, the same walk made none.

Three families of lazy formats are in common use:

| Format | Cross-image dedup | Fit under gVisor |
| --- | --- | --- |
| EROFS; Nydus RAFS v6 (EROFS on disk) | Good with content-keyed chunks | Host kernel EROFS mount over a block device, read through directfs |
| eStargz, SOCI | None across independent builds | FUSE daemon: a userspace round trip per uncached lookup or read |
| overlaybd | Fragile: layout differs per build | Host mount; metadata lookups become remote reads |

eStargz and SOCI suit fleets with little to gain from dedup. overlaybd treats the image, the writable layer and snapshots alike as block devices, a good fit for VMs: DSec uses it for microVM writable disks. Under gVisor, the Sentry keeps guest writes in its filestore whatever the image format. For the read-only image, I chose RAFS v6, the best of the three on dedup and on local metadata.

gVisor's own EROFS reader returns `ENOTSUP` for chunk-based inodes, the layout of every RAFS v6 regular file, so the node daemon mounts images on the host and the Sentry reads them through directfs. Behind the host mount, a userspace daemon fetches the chunks. When a fetch fails, whether the sandbox gets an error or wrong bytes depends on that daemon and how it talks to the kernel.

### 4.4 Making the reader daemon fail closed

Suppose the daemon crashes while a sandbox imports a library, and the kernel completes the read with zeros instead of an error. Python rejects source code that contains null bytes, and the dynamic loader rejects a zeroed shared library, so the import fails with a confusing error. Nothing on the platform notices: no daemon reports a failure, so the rollout isn't masked as a sandbox error and gets reward 0 as if the agent had broken something. The zeros can also stay in the page cache, where later sandboxes on that image read them too. A zeroed data file, such as a test fixture, is worse, since the tests then run to completion on wrong input. The read path has to fail closed to rule all of this out (the third requirement at the start of this section).

The Linux kernel can hand a page-cache miss to a userspace daemon in several ways. NBD [@nbd], the kernel's network block device, forwards block reads over a socket to a userspace server. Our first reader was a Python NBD server, the baseline in the Evidence column. The Daemon death column is the one that matters here:

| Mechanism | Daemon restart | Daemon death | Evidence |
| --- | --- | --- | --- |
| FUSE | Takeover if a supervisor holds the `/dev/fuse` fd | `ENOTCONN` | Not built: metadata upcalls on every cold path walk |
| EROFS over cachefiles on-demand [@cachefiles] (fscache) | Plain restart broke every mount (`ENOBUFS`) | Mounts unusable | 20-way cold start 4.0 s vs 8.3 s for a Python NBD server |
| fanotify `FAN_PRE_ACCESS` | A new listener can register | **Open**: pending events answered ALLOW | 24 MB of zeros, still cached after re-registration |
| NBD + kernel EROFS | None in nydusd | **EIO** in 45 ms | 64 cold images: 31.5 s to 10.6 s wall vs a Python NBD server |

fanotify drops out first, because after its listener died the sandbox read zeros. FUSE fails closed, but the kernel then makes an upcall to the daemon on every cold path walk, a cost I'd accept only to upgrade daemons without draining their sandboxes. fscache was the fastest reader in these tests, but upstream deprecates it, and our workers' kernel is built without `CONFIG_EROFS_FS_ONDEMAND` anyway.

We use stock nydusd in NBD mode. nydusd exposes each RAFS v6 image as a block device, which the host kernel mounts as EROFS, so the kernel serves metadata from its page cache without upcalls. When nydusd died, the kernel's NBD driver failed the pending reads with EIO within about 45 ms. I also ran 64 sandboxes and killed several daemons in the middle of reads: only the sandboxes reading from those daemons failed, and the rest exited cleanly. A cold `import sys` ran about 11 times faster at the median than with the Python NBD server. Running nydusd has some costs:

- Upstream marks NBD mode as experimental.
- When a daemon dies, every sandbox reading its image fails and has to start again.
- Each per-image daemon used about 20 MB of resident memory.
- With readahead, nydusd fetched two to four times the bytes of the Python reader, so the store node serves more requests.

A live nydusd can still serve wrong bytes, for example if S3, the store node or the chunk index returns the wrong range of a pack file after a fault. So nydusd, the last process to handle the bytes before the kernel, checks every chunk. The check follows a chain of digests from a root that the gateway signs with Ed25519 down to each chunk:

1. The gateway signs a root with its Ed25519 key. The root carries the digests of the image's bootstrap and chunk map, along with the image format. At signing time, the gateway also adds the toolkit layer, holding the agent harness, to the image's manifest, so the signed root covers the toolkit layer as well as the image. Before starting nydusd, the node daemon checks the signature and the digests of the bootstrap and chunk map it fetched from the store node.
2. From the bootstrap and the chunk map, nydusd reads the digest of each pack file's table of contents, the blob TOC.
3. From the blob TOC, nydusd reads the sha256 of every chunk, computed by the converter as the chunk's identity.
4. When a chunk arrives, nydusd hashes its uncompressed bytes and compares the result with the expected digest before it answers the kernel.

Because nydusd checks every chunk, we can treat S3, the store node and the chunk index as untrusted and change any of them without revisiting integrity. nydusd checks the blob metadata digest only with its blob-TOC feature enabled, and so we enable that. On a mismatch, nydusd returns EIO to the kernel, after which the node daemon marks the image bad and refuses further creates from it.

Take the first `import numpy` from this image on a worker:

1. The guest's `open` and `read` calls go to the Sentry, which resolves the path with `*at` syscalls through directfs and reads the host file (Section 3.3).
2. On the host, the file comes from an overlay over the image's EROFS mount. The host kernel resolves the path from the metadata zone kept on the worker, without a remote request.
3. The host kernel finds the file's data missing from the page cache, so EROFS requests the blocks from the NBD device under the mount. The NBD driver forwards the request over a socket to the image's nydusd.
4. nydusd maps the blocks to chunks and looks them up in the chunk cache, 128 GiB of cache files on the worker's local disk, shared by all per-image daemons. On a miss, nydusd fetches the compressed chunks from the store node, plus readahead. It checks each chunk against its digest before adding it to the cache.
5. nydusd answers the NBD request. Once the kernel has filled the page cache, the Sentry copies the bytes into the guest's buffer.

When any sandbox on the same image and worker reads the file again, the host kernel finds the pages in its page cache at step 3 (Section 3.4). If nydusd dies at step 4, or a chunk fails its check there, the kernel ends the read with EIO. The rollout then stops with a visible error instead of producing a wrong reward.

When the store node is slow, a read blocks instead of failing. In our object storage, about 2% of GETs stalled for 6 to 60 s, often again on retry, so nydusd retries a fetch for up to 270 s. We set the kernel's NBD timeout to 600 s, above that budget, because each NBD timeout permanently kills one of the device's connections. A stalled fetch then only adds latency. If the store node is down, nydusd gives up after 270 s and the read fails with EIO, after holding the sandbox's memory for almost half of the off-policy window in this post's example.

With lazy loading, the sandbox still waits for its image, just later and in smaller pieces. Going by the bytes a rollout's first commands fetch, nydusd sends roughly 140 to 200 requests to the store node for a cold image, and the sandbox waits on them during those commands, after a create that took 1.3 s at the median. In a cold `pip --version`, nydusd's fetches took most of the 1.1 s (Section 3.3).

## 5. Waiting for the model

A coding agent executes tool calls and then waits for the next action. For simplicity, we'll assume model waits of 15 to 25 s, as in our pressure trial. That range is a stand-in we chose for the fake model, not a measurement: real waits depend on the model, the length of its output and queueing at the inference servers (Section 2.2). Meanwhile, each sandbox holds about 0.54 GiB of memory on average. The node daemon can leave that memory where it is, or write it to disk to free RAM for other sandboxes and read it back before the agent continues, which can make the turn take longer.

Our node daemon pauses sandboxes at every model wait and generally leaves their memory in place, swapping pages where necessary. It hibernates a sandbox only when the worker is short of memory and swap is full (Section 5.1). In a load test under memory pressure, the p95 wake was 0.13 s with this policy and 14.2 s with a policy that hibernates waiting sandboxes whenever memory runs short.

### 5.1 Holding memory or writing it out

A waiting sandbox can be in one of five states. From the most memory held to the least, the states are:

1. resident: running as usual,
2. paused: guest tasks stopped and memory resident, back in about 10 ms,
3. reclaimed: paused, with some pages moved to swap on the worker's NVMe, back in a fraction of a second,
4. hibernated: memory and guest writes captured to local disk, back in seconds,
5. published: the hibernated state uploaded, so another worker can wake the sandbox.

For a model wait, it is almost always better to keep the memory. Writing out a 1.5 GiB guest and reading it back takes about as long as the 20 s wait itself. In the pressure trial (Section 5.5), the waits that ended hibernated pushed the p95 wake to 14.2 s.

Gray's five-minute rule answers the same question for database pages. It says to keep a page in RAM if it will be used again within about five minutes, and otherwise to write it out and read it back when needed [@gray1987]. For a sandbox holding R resident bytes through a wait of t\_w seconds, whose capture writes a footprint of F bytes and reads them back at the restore, the rule says to hibernate only when

$$t_w \, R > T \, F, \qquad T = 300\ \text{s}$$

Take a 1.5 GiB guest. Under `--overlay2=root:self`, a capture writes the guest's memory plus all of its file writes (Section 3.3), so F is at least R. With Gray's T of 300 s:

- With F equal to R, t\_w has to exceed 300 s.
- After 2.5 GiB of guest writes, F grows to about 2.7 times R, so t\_w has to exceed an estimated 800 s.
- With a 20 s wait, F has to stay below R/15, about 100 MiB, well under its minimum of R.

The figure puts these break-even times, plus one estimated from disk bandwidth, on a log scale of wait length.

![Model waits against the wait length at which hibernating starts to pay off under Gray's rule.](hurry-up-and-wait-part-1/06-break-even.svg)

Model waits are more than ten times shorter than the 300 s break-even, and guest writes push the break-even further out. Our node daemon keeps these sandboxes paused and reclaims some of their pages to swap.

Gray and Graefe later gave a version of the rule for sequential reads [@gray1997]. With current NVMe bandwidth, that gives a time T of a minute or two. Even then, with F equal to R, a 20 s wait falls several times short. I kept Gray's original 300 s in the node daemon, so waits between the two lines stay paused.

On the current build, with the memory file on tmpfs, gVisor wrote about 1.5 GiB for each capture of a 1.5 GiB heap, because it copies the allocated extents of the application memory file. On earlier builds, a hibernation took about 0.25 s at the median for a guest with few writes, and tens of seconds for a guest with 2.5 GiB of `/workspace` writes. I expect captures on the current build to take longer than 0.25 s and to grow with guest memory.

We choose to hibernate sandboxes only on a worker short of memory, because the worker's DRAM costs the same whether or not a sandbox holds it. Swap usually costs less, since the kernel only writes out the coldest pages, at most R bytes, and then reads back only the ones the guest touches. Hibernation writes all of F before it frees anything. The node daemon hibernates instead of swapping only when:

- swap is full,
- the worker has to be emptied,
- reclaiming paused sandboxes to swap has stalled twice in a row.

If the node daemon knew how long a wait would last, it could hibernate the sandbox right away whenever the worker is short of memory and t\_w R > T F holds. It's difficult to predict how long a model will think, so waits currently come without a hint.

Under memory pressure, the node daemon instead reclaims paused sandboxes to swap, starting with the most recently paused, since the one paused longest is the likeliest to wake next.

When spare memory on the worker falls below a threshold, the node daemon frees a paused sandbox's memory by writing to the `memory.reclaim` file of its cgroup. The kernel then moves the sandbox's pages to swap on the worker's NVMe, at hundreds of MiB/s. With zswap on, the kernel compressed incompressible pages into a pool in RAM charged to the same cgroup, so the cgroup's usage hardly dropped. zswap is off by default on our workers.

### 5.2 Pausing a gVisor sandbox

On gVisor, `runsc pause` stops the guest's tasks in milliseconds and writes nothing to disk. The Sentry, the gofer and the netstack keep answering the host in the meantime.

DSec [@dsec] pauses containers by freezing their cgroup, then writes to `memory.reclaim` to push the pages to swap and prefetches them with `MADV_WILLNEED` on resume. Here we use `runsc pause` instead of freezing. The kernel reclaims from a cgroup whether or not its tasks run, so reclaim doesn't need the freeze. Freezing would also stop the Sentry, and the node daemon would then have to thaw the cgroup before every `runsc resume` and `runsc exec`, and on every crash path.

Pausing doesn't free any memory, but it does stop the agent's processes from using CPU, and pages that reclaim pushed to swap stay there until the thaw instead of being faulted back in by a running guest. Since the gateway's route and the node daemon's journal both still list a paused sandbox as running, pausing and resuming need neither the gateway nor PostgreSQL.

A pause and a resume each took under 10 ms at the median, so pausing on every turn adds about 18 ms, under 0.1% of a 20 s wait.

### 5.3 Detecting model waits from packet headers

The agent's model calls already pass through the relay, so our first design let the relay drive each pause. The relay asked the gateway to pause the sandbox when a call went out and to thaw it before delivering the answer, with the relay and the gateway each writing every step to PostgreSQL: about 20 statements and four network round trips per wait. At about 50 waits per second, that is little load for PostgreSQL. But this put the gateway and PostgreSQL on the path of every model call: with a slow or restarting gateway, every agent in the fleet would wait at its next turn. Most of that work also only confirmed that a sandbox should stay as it was. The node daemon now makes the decision itself, from packet headers on the relay connection:

- **Observe.** The agent calls the model relay in plain HTTP/1.1 on the private network. Following an nftables rule, the kernel copies the first 64 bytes of each relay packet to an NFLOG group (the kernel's packet-logging target). The node daemon reads the copies over netlink and decides from the IPv4 and TCP headers alone, using their ports, flags and lengths.
- **Pause.** Once 50 ms pass with no inbound data after the flow's last outbound payload, the node daemon checks the sandbox's `cpu.stat`. If the sandbox used at most 2 ms of CPU in those 50 ms, the node daemon pauses it. While an exec or another lifecycle call runs in the sandbox, the node daemon leaves it running.
- **Thaw.** The node daemon thaws the sandbox when the NFLOG copies include the answer's first inbound data packet, a FIN or an RST. By then the paused netstack has already ACKed the data and buffered it.
- **Confirm.** The relay commits the answer to PostgreSQL together with a fallback wake row due in 5 s, then writes the answer to the agent's socket. For up to 4 s, it then polls the socket with `TIOCOUTQ`, an ioctl returning the count of bytes still unacknowledged by the peer. When the count drops to zero, the sandbox's Sentry has acknowledged every byte, so the relay cancels the fallback row with an UPDATE. A hibernated Sentry sends no ACKs, so the count stays above zero until the row comes due and the gateway wakes the sandbox.

To see whether pausing breaks TCP, I delayed a 1 MB answer by 2 s. It arrived with no retransmissions or timeouts, and the thaw took 9.8 ms at the median.

Under TLS 1.3, the server sends session tickets after the handshake, and in a short experiment with TLS, the node daemon mistook the tickets for the answer and thawed sandboxes early, on the first call of each connection. I kept the relay connection in plaintext, since the traffic stays on the private network and each rollout has its own relay token.

On a production canary worker, the node daemon handled every model wait without the gateway. The time for an answer to reach the agent dropped from 54 to 30 ms at p95, though both are small next to a 20 s wait.

![Pausing a sandbox through the relay and gateway (before), and from packet headers in the node daemon (after).](hurry-up-and-wait-part-1/07-relay-before-after.svg)

The gateway and PostgreSQL now only appear on the dashed fallback path.

If a worker's pause counter stays flat while its sandboxes wait for the model, pausing has stopped working. The node daemon can't read waits from the headers when the relay URL uses TLS, and it never pauses a sandbox while an exec runs in it, so a log poll that runs an exec every few seconds keeps the sandbox running.

### 5.4 Thawing by reading the memory file from the host

Resuming the guest and letting it fault its pages back in from swap is slow. The node daemon reads the memory file from the host with eight parallel readers before it resumes the guest, which brings the pages back several times faster.

When the guest accesses a swapped page, its host thread takes a synchronous fault in the host kernel's swap-in path, below gVisor. The kernel reads at most 2^`page-cluster` pages around the faulting slot, up to 32 KiB by default, then blocks the thread until they arrive, so only about one read per faulting thread is outstanding at a time. A single thread faulting pages in from swap got about 120 MiB/s, whether it ran natively, under runc or under runsc. With a larger `page-cluster`, only sequential scans sped up, because a guest with scattered access rarely reads the neighboring pages next.

Before `runsc resume`, the node daemon walks the memory file's allocated extents with `lseek(SEEK_DATA)` and reads them with eight threads of plain `pread` in 1 MiB reads, up to 1 GiB or 2 s. In a prefetch test, it read back 645 MiB in under a second, 4 to 6 times faster than guest faults on the same pages. With eight thaws at once, each took about 3 s.

Guest memory on our workers is tmpfs shmem, and on swap-in the kernel charges a shmem page to the cgroup recorded in its swap entry, whichever process reads it. The prefetched pages therefore still count against the sandbox's cgroup.

### 5.5 Pausing against hibernating under memory pressure

The 140-agent pressure trial compared pausing, with reclaim to swap and prefetch at the thaw, against hibernating: keeping waiting sandboxes resident and hibernating them whenever the worker ran short of memory, even for 20 s waits that our node daemon would keep paused. It was a load test with one run per arm on a 48-vCPU, 192 GB worker. The pausing arm had 128 GB of swap with zswap on, limited to a quarter of each paused sandbox's memory, and the hibernating arm ran without swap. In each arm, 140 synthetic agents each held a 1.5 GiB random heap in a 2 GiB limit through 8 cycles of 20 plus or minus 5 s model waits.

![Wake time per model wait in the 140-agent pressure trial, pausing against hibernating.](hurry-up-and-wait-part-1/08-wake-times.svg)

At p95, a wake took 14.2 s in the hibernating arm and 0.13 s in the pausing arm, more than 100 times faster. In the hibernating arm, 157 of the 1,120 waits ended hibernated, and none did in the pausing arm. The median wake took about 0.02 s in both arms, so the gap at p95 comes from the hibernated waits.

That 0.13 s is far below the thaw times in the prefetch test. At its read rate, 0.13 s is enough for about 100 MiB, so in at least 95% of the pausing arm's wakes, the node daemon read back roughly 100 MiB or less from swap. A wake after heavy reclaim still takes a second or more, and on a worker under heavier pressure than in the trial, I expect more wakes to take that long.

On average, a wake took 1.8 s in the hibernating arm and 0.06 s in the pausing arm, so the trial's eight waits added about 14 s and 0.5 s to a rollout's W. At 3.3 rollouts per second, hibernating would keep an estimated 50 more sandboxes live, holding about 26 GiB. In the trial itself, the hibernating arm took about 5% longer to finish all 140 rollouts.

## 6. Conclusion

gVisor gave us a sandbox boundary we could run on VMs without `/dev/kvm`. It adds little memory of its own, but tools that make many syscalls run slower under it, which keeps their sandboxes alive longer. Under asynchronous training, a sandbox holds its memory for as long as its rollout runs, so most of the work in this post went into shortening the time a sandbox spends on anything other than the agent's own work. Lazy reads from a deduplicated chunk store cut the median wait for a first create from 92 s to 1.3 s, and pausing at every model wait cut the p95 wake under memory pressure from 14.2 s to 0.13 s.

Much of this design follows from our constraints, and a team with different ones should choose differently. Some examples:

- With `/dev/kvm`, a microVM gives each task its own real kernel, and a group's sandboxes can share a prepared sandbox's memory. I think microVMs have a lot of advantages, but gVisor has also been really nice to work with.
- When each worker runs few distinct images, whole-image pulls are simpler, and the chunk store adds little.
- With model waits of many minutes, hibernation starts to pay off. This would be even more efficient if we could predict how long the model will think.
- With TLS on the connection to the model, the node daemon can't detect waits from packet headers.

My estimates also assume that most of our groups finish well inside the off-policy window, so overhead mostly costs us memory. With a wider spread of rollout lifetimes, more groups would finish late, and the same overhead would drop more of them. On another setup, that spread is the first thing I would measure.

That said, I'm hoping to write a part 2 of this. I want to write more about scaling the service up to thousands of sandboxes at once. At that scale, there are a bunch of new issues that haven't been discussed yet. And I want to write more on creating and curating environments for our RL training.
