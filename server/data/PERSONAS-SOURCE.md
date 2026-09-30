# Persona pool provenance

`personas.json` is the illustrative visitor population that the persona simulation samples from. It is **not** a record of real visitors to any site, and the segment weights are editorial choices, not measured traffic.

## Origin

- **Dataset:** [NVIDIA Nemotron-Personas-Korea](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea), a synthetic dataset of Korean personas grounded in national demographic distributions, released under **CC BY 4.0**.
- **Sampling:** 928 rows were selected on 14 May 2026 by filtering the dataset with segment-specific rules (age range, education, occupation keywords, region) and then randomly sampling inside each segment (`random.seed(42)`). Each row keeps its demographics and a truncated persona description; the long-form persona fields were dropped.
- **Segmentation:** the ten segments below were designed for the site of a B2B pop-up-store agency, the site the earlier prototype was built around. Persona-level `weight` is 0.1 for every row, so a segment's share of the population equals its share of rows.

| Segment | Rows | Share |
| --- | --- | --- |
| `brand_marketer_large` — brand marketers at large and mid-size companies | 180 | 19.4% |
| `popup_enthusiast` — pop-up store enthusiasts (MZ, mostly women) | 150 | 16.2% |
| `brand_marketer_startup` — startup / SMB marketers | 120 | 12.9% |
| `kpop_fan` — K-pop fans visiting for idol pop-ups | 100 | 10.8% |
| `building_owner` — commercial property owners | 80 | 8.6% |
| `retail_trend_watcher` — retail trend researchers | 80 | 8.6% |
| `franchise_explorer` — small-capital franchise explorers | 70 | 7.5% |
| `md_manager` — retail merchandising managers | 60 | 6.5% |
| `retail_tenant` — retail tenants (brand store placement) | 48 | 5.2% |
| `jobseeker` — job seekers | 40 | 4.3% |

## What each persona carries

```json
{
  "id": "brand_marketer_large_1",
  "segment": "brand_marketer_large",
  "name": "대기업/중견기업 브랜드 마케터",
  "persona_name": "…",
  "description": "…",
  "weight": 0.1,
  "demographics": { "age": 38, "sex": "여자", "occupation": "마케팅 전문가", "education": "…", "province": "경기", "district": "…", "marital_status": "…", "family_type": "…", "housing_type": "…" },
  "traits": { "patience": 0.65, "visualSensitivity": 0.8, "copyImportance": 0.75, "ctaResponse": 0.55, "priceConsciousness": 0.35, "socialProofSensitivity": 0.85 },
  "goals": { "conversion": "AI 견적 계산기 제출", "interests": ["포트폴리오", "…"], "avoid": ["로그인", "회원가입", "채용"] }
}
```

`traits`, `goals.interests`, `goals.avoid` and `goals.conversion` are per-segment editorial values written for the original prototype; the heuristic policy uses them to weigh actions, the LLM policy quotes them in the system prompt. The keywords are specific to that site's vocabulary, so on other sites they mostly act as a "no interest signal here" baseline.

## Using your own pool

Set `PERSONA_POOL_PATH` to a JSON file with the same shape: either an array of personas or `{ "source": "...", "segments": [{ "id", "label" }], "personas": [...] }`. Only `id` and `segment` are required; missing traits default to 0.5, missing weight to 1. Segment weights are derived from the persona weights, so adjust `weight` per persona to change the mix.
