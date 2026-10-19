# Results

200 alerts (50 page, 84 ticket, 66 ignore; 108 hard), up to 3 runs per model. Reference for the paired comparisons: qwen3.8-max.

| model | accuracy | hard | easy | missed pages /run (of 50) | false pages /run | same answer all runs | $ per 1,000 alerts | p50 ms | p95 ms | calls (failed, invalid) |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-0731 | 100.0% | 100.0% | 100.0% | 0.0 | 0.0 | 100.0% | 0.157 | 4391 | 10729 | 600 (0, 0) |
| qwen3.8-max | 100.0% | 100.0% | 100.0% | 0.0 | 0.0 | 100.0% | 1.640 | 1275 | 2601 | 600 (0, 0) |
| openai-gpt-oss-120b | 99.8% | 100.0% | 99.6% | 0.0 | 0.0 | 99.5% | 0.194 | 3106 | 5108 | 600 (0, 1) |
| llama-4-maverick | 99.5% | 100.0% | 98.9% | 1.0 | 0.0 | 99.0% | 0.189 | 1935 | 3334 | 600 (0, 0) |
| openai-gpt-oss-20b | 99.2% | 99.7% | 98.6% | 1.0 | 0.0 | 97.5% | 0.144 | 2359 | 5259 | 600 (0, 0) |
| mistral-3-14B | 88.7% | 91.0% | 85.9% | 4.7 | 6.0 | 80.0% | 0.149 | 813 | 1800 | 600 (0, 0) |
| baseline:severity-label | 51.0% | 9.3% | 100.0% | 14.0 | 39.0 | 0.0% | 0.000 | 0 | 0 | 200 (0, 0) |

## What 200 alerts can and cannot rule out (alerts are the unit; one-sided 95% upper bounds)

| model | alerts wrong in any run (of 200) | true error rate could still be up to | page alerts missed in any run (of 50) | true miss rate could still be up to |
|---|---|---|---|---|
| deepseek-v4-flash-0731 | 0 | 1.5% | 0 | 5.8% |
| qwen3.8-max | 0 | 1.5% | 0 | 5.8% |
| openai-gpt-oss-120b | 1 | 2.3% | 0 | 5.8% |
| llama-4-maverick | 2 | 3.1% | 2 | 12.1% |
| openai-gpt-oss-20b | 5 | 5.2% | 3 | 14.8% |
| mistral-3-14B | 42 | 26.3% | 8 | 27.0% |
| baseline:severity-label | 98 | 55.0% | 14 | 40.3% |

## Paired comparison with qwen3.8-max (percentage points, 95% bootstrap CI over alerts)

| model | accuracy diff | CI | missed-page rate diff | CI |
|---|---|---|---|---|
| deepseek-v4-flash-0731 | +0.0 | +0.0 to +0.0 | +0.0 | +0.0 to +0.0 |
| openai-gpt-oss-120b | -0.2 | -0.5 to +0.0 | +0.0 | +0.0 to +0.0 |
| llama-4-maverick | -0.5 | -1.3 to +0.0 | +2.0 | +0.0 to +5.3 |
| openai-gpt-oss-20b | -0.8 | -1.7 to -0.2 | +2.0 | +0.0 to +4.7 |
| mistral-3-14B | -11.3 | -14.8 to -8.0 | +9.3 | +3.3 to +16.0 |
| baseline:severity-label | -49.0 | -56.0 to -42.0 | +28.0 | +16.0 to +40.0 |

## Which model served each call

- deepseek-v4-flash-0731: deepseek-v4-flash-0731 600
- qwen3.8-max: qwen3.8-max 600
- openai-gpt-oss-120b: openai-gpt-oss-120b 600
- llama-4-maverick: llama-4-maverick 600
- openai-gpt-oss-20b: openai-gpt-oss-20b 600
- mistral-3-14B: mistral-3-14B 600
- baseline:severity-label: none 200
