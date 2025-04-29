---
title: "Quantifying LLM Base Model Quality through Compression"
date: 2025‑04‑29
bib: leaderboard.bib
# tags: ["llms", "compression", "evaluation", "leaderboard"]
summary: "Introduces a Danish-centric benchmark and leaderboard that grades base LLMs by compression efficiency on fresh Danish, English and Python text."
---

**TL;DR:** I introduce a Danish-centric benchmark and public [leaderboard](/leaderboard.html) that scores base LLMs by how well they compress unseen Danish, English, and Python text (lower = better) - an information-theoretic lens on predictive power that avoids most training-data contamination. On this metric, models as small as `munin-7b-alpha` rival or beat much larger baselines, several European models are in the game, and Gemma 3 tops the board.

---

## Leaderboard Snapshot

If you just want the scores, here are the some of the more interesting ones taken from the full [leaderboard](/leaderboard.html). Please visit it for interactivity and to see all the results.

| Model | Danish Fiction | Danish Non-fiction | Danish Wiki 2025 | Danish News 2025 | English Wiki 2025 | Python 2025 |
|-------|-----------:|--------------:|------------:|--------:|------------:|-------------------:|
| **gemma-3-27b-pt** | 12.69 | 11.31 | 8.64 | 8.55 | 7.29 | 4.00 |
| **Meta-Llama-3.1-70B-FP8-Dynamic** | 12.72 | 10.98 | 8.78 | 9.36 | 7.01 | 3.92 |
| **EuroLLM-9B** | 13.59 | 12.07 | 9.32 | 9.53 | 8.12 | 5.35 |
| **munin-7b-alpha** | 13.01 | 12.42 | 9.88 | 9.47 | 8.37 | 5.30 |
| **Mistral-Small-24B-Base-2501** | 14.71 | 12.59 | 9.75 | 10.42 | 7.48 | 4.05 |
| **Qwen3-30B-A3B-Base** | 14.48 | 13.43 | 10.96 | 10.79 | 7.91 | 3.47 |

**Metric** = `compressed_bytes / original_bytes * 100`, so lower is better.

## How to interpret the results

The benchmark provides a specific, information-theoretically grounded perspective on base model quality, with a specific focus on generalization to unseen Danish data. In order to interpret the results well, a few things should be made clear. 

First, do not overindex on the 'average' column - it's mainly there for you to sort by. In fact, it's just a naive mean over the other columns with no thought put into their weightings. Also, do not compare scores across columns. Each dataset is quite different, and so compresses differently. You should instead compare across models within each column, to see which models perform best at compressing the given dataset. This hopefully tells you something meaningful about the models relative performance.

For example, you can see that the Gemma models are all very impressive across the board. Many of the Nordic and European models are actually quite good at Danish, but worse at English and Python. We might infer that Mistral seem to have focused more on English and code than European languages. The Qwen models have very impressive code performance, but lag behind on both Danish and English. Munin-7b-alpha, which we released in January 2024, is still one of the best-performing models for Danish, despite being based on the now old Mistral-7b-v0.1.

## Why is this interesting?

I needed a quick, contamination-proof signal to guide pre-training experiments at [Danish Foundation Models](https://foundationmodels.dk). The loss, or compression rate, is quick and easy to calculate, and since the text we measure it on is newer than any text the models have been trained on, there's a pretty low risk of contamination. As I will explain below, the compression rate is correlated with downstream task performance, and probably also with overall model intelligence, as long as we measure on representative data.

Since I was going to build this anyways, I figured it makes sense to publish it for your (potential) enjoyment. This is the only benchmark of its kind in Danish, to my knowledge. Of course, there's also [EuroEval](https://euroeval.com/leaderboards/) (formerly ScandEval) if you want to know which models are good at Danish. While useful, I believe existing task-specific evaluations are significantly less general than what we measure here. They are also significantly easier to intentionally or unintentionally hillclimb, and all of the benchmarks are extremely likely to already be in training sets. Nonetheless, to the extent that you care about specific skills tested in such benchmarks, *and* you believe the models are not overfit to the benchmarks, they might still have their uses. Empirically, we do see many of the best (human-preferred) models topping the EuroEval leaderboards. This benchmark is complementary and focused on base models only. 

## Methodology

**Corpus:** Finding novel text in a relatively low-resource language such as Danish is a challenge, especially for model training. For this benchmark, however, we have the luxury of being able to use copyrighted data with no concern due to the EU DSM Article 3. Hence, I gathered four novel text sources published solely after January 1 2025: Online news articles in Danish, Wikipedia articles in Danish and English, and Github repositories containing Python code. These represent the online-available sources of the dataset, and so it's very important that they're strictly newer than the model training cutoff date. For text that generally isn't available online, I find it less important to consider the publication date. Hence, I use Danish e-books from my personal collection, including both older and newer fiction, and some relatively new non-fiction. These texts are not easily available online (certainly not legally), and so it is less likely that models have been trained on them. While they *are* available through sources like Anna's Archive, my guess is that existing models are more likely to include only English subsets. Note that the evaluation corpus will *not* be publicly available; you won't be able to compare your own models with my scores. Feel free to build your own corpus.

**Evaluation pipeline:** `raw text chunks -> tokenizer -> log probs -> entropy code-length -> compression rate`. The expression for the compression rate for a sequence $x_{1:N}$ is $C = \frac{S_{nats}}{8 B \ln(2)} \cdot 100$ where $S_{nats} = -\sum_{i}^N\ln p_\theta(x_i | x_{\lt i})$ is the negative log-probabilities summed in units of nats, and $B$ is the number of bytes in the sequence. I use compression rate because it feels more intuitive than other options, such as perplexity or bits-per-byte; everyone can relate to “If I encode the text with the model, the size shrinks to $C\%$.” The tokenizer, which by itself is a compressor, is treated as part of the system and we measure the end-to-end compression. One choice that must be made is the sequence length $N$, and currently I've chosen fixed chunks of 1024 tokens. It could be useful to compare e.g. with a much higher value of $N$. Finally, the compression rate is calculated *per-dataset*. This reveals interesting things about model performance and gives insights into what data the models plausibly have been trained on.

## Compression ↔ Prediction ↔? Intelligence

So, the link between compression and prediction is well-known and I won't bore you, my dear reader, with it. Of course you have read Shannon [@shannon1948mathematical] saying that optimal compression = optimal prediction. However, is prediction really intelligence? And is that really what we're measuring? Let's investigate a bit.

Marcus Hutter and Shane Legg have explored "universal intelligence" [@legg2007universal] for many years, and they have also collected various definitions of intelligence [@legg2007collection]. The universal intelligence of an agent is formalised as the weighted average of the total reward that the agent can obtain in every computable, reward-summable environment. This theory exactly relates better prediction to greater intelligence, but it also purposefully goes beyond mere passive prediction. We're getting somewhere, but it's very theoretical and not a perfect fit for LLMs.

Schmidhuber has of course also worked a lot on compression and agents, for example by relating compression to curiosity [@schmidhuber2009driven] and for starting what later became the [Hutter prize](http://prize.hutter1.net/). However, it doesn't seem to me like compressing some old English Wikipedia dump will result in AGI.

Perhaps we should look at newer results that are more specifically concerned with LLMs. Huang et al. [@huang2024compression] showed correlation between loss and downstream zero-shot benchmarks performance. While I disagree with the framing of average benchmark scores as intelligence, this is still a useful result for us. I would like if my models have better downstream benchmark scores, thank you.
Delétang et al. [@deletang2024language] use LLMs as compressors by actually performing arithmetic coding, and compress various data modalities besides text, such as images and audio. Surprisingly, LLMs are good at compressing these modalities, despite never being trained on them.

There's also this idea of "emergent abilities"; that LLMs "suddenly" during training gain certain abilities. While this framing has been questioned from various angles, Du et al. [@du2025understanding] study it through training loss. They find that downstream abilities are predicted by the pre-training loss regardless of model size and training compute. Furthermore, certain downstream evals have emergent properties where performance is essentially random until pre-training loss drops below a *shared* threshold, after which rapid improvement is observed.
Very similarly, Gadre et al. [@gadre2024scale] find that validation loss predicts downstream top-1 error across models.

To sum up, we have a lot of things pointing suggestively at the link between what we're measuring and intelligence, but there are unfortunately plenty of caveats. For example, not all tokens are equally important to predict [@fang2025wrong], and models that are good at next-token prediction are not always good at in-context learning [@shin2022effect]. Prediction, and thus compression, is a necessary but not sufficient condition for intelligence; the same loss can likely be achieved by very different internal representations, and only some support generalization and reasoning. This benchmark is useful for selecting for better, smarter base models, but we will continue using downstream task evaluations for things we actually care about, and for post-trained models.

Please visit the [leaderboard](/leaderboard.html)! I welcome constructive feedback on methodology, results, or potential improvements. I bet there's a lot of things that could be done in the future, or could've been done better already. You can contact me at [rasmus.larsen@alexandra.dk](mailto:rasmus.larsen@alexandra.dk) or **@synquid** on Discord.

Shout out to [Jellyfish042/UncheatableEval](https://huggingface.co/spaces/Jellyfish042/UncheatableEval) which inspired the use of new online data for benchmarking.
