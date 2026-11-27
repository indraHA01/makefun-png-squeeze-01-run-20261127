[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/indraHA01/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/indraHA01/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze — squeeze screenshots into the smallest PNG

A lossless PNG re-encoder built for the [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127) **png-squeeze-01-run-20261127** bounty. One program, `main.ts`, reads 8 screenshots (1280×720 RGBA) and writes each back as the smallest valid PNG it can, losslessly, inside a 60-second wall budget on 1 CPU.

## How it works

1. **Decode** the stored PNG to RGBA.
2. **Adapt the form to the image**: palette (colour type 3, transparent entries first so `tRNS` stays short) when there are at most 256 colours, grey (0) or grey+alpha (4) when every pixel is grey, RGB (2) with a `tRNS` key when there is exactly one transparent colour value, RGBA (6) otherwise. Two palette orderings are tried — by count and by luminance.
3. **Search the filters per row**: fixed filters, the minimum-sum and fewest-pairs heuristics, and brute force (each filter trial weighed by a real deflate of the row after its 32 KiB of context). Every form+filter candidate is weighed by a real zlib level-6 stream, so the winner is chosen on bytes, not on a guess.
4. **Re-encode with our own optimal-parse deflate** — a zopfli-style shortest-path parse over hash-chain matches (deep chains, two cost-refinement passes), written in pure TypeScript with length-limited Huffman codes (Kraft-exact redistribution, so the tables are always valid). The result is compared with zlib level 9 and the smaller stream wins, so it never does worse than the stock compressor.

Everything is deterministic: no clock, no randomness, no network — the two graded executions write byte-identical outputs.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+ (erasable TypeScript only, built-in modules only, no dependencies).

## Practice-set results

| instance | theme | bytes | points (of 1000) |
|----------|-------|-------|------------------|
| i001 | flat | 12,455 | 720 |
| i002 | rich | 50,381 | 723 |
| i003 | alpha | 99,473 | 719 |
| i004 | grey | 100,432 | 728 |
| i005 | flat | 16,214 | 754 |
| i006 | rich | 170,614 | 719 |
| i007 | alpha | 60,890 | 702 |
| i008 | grey | 24,378 | 727 |

**Total: 724,086 of 1,000,000** — vs 420,399 for the house baseline (fixed-paeth 1.0.0) and 666,667 for the scale compressor. All 8 instances answered, both runs byte-identical, ~34 s for the whole set locally.
