# transform — dbt project

Layered transforms over the warehouse tables Drizzle owns. The app reads marts; ad-hoc analysts read marts; nobody reads raw `*_raw` tables directly outside this project.

## Layers

| Layer | Materialization | Schema | Purpose |
|---|---|---|---|
| `staging/` | view | `stg` | Renames, casts, light cleanup of source tables. One file per source. |
| `intermediate/` | ephemeral | (n/a) | Joins/business logic that produces reusable building blocks. |
| `marts/` | table | `marts` | Final exec-facing models; one per question on the home page. |

## Setup

```bash
pip install dbt-postgres==1.8.*
cp profiles.yml.example ~/.dbt/profiles.yml
dbt deps
dbt build --target dev
```

## Conventions

- **Naming:** `stg_<source>__<entity>`, `int_<domain>_<verb>`, `mart_<question>`.
- **Tests:** every staging model has `not_null` + `unique` on the surrogate key; every mart has at least one `dbt-expectations` cell-size or relationship test.
- **Aggregates over comp** must enforce `min_cell_size >= var('min_cell_size')` (default 5) — see `app.assert_min_cell_size` in the RLS layer.
- **No raw schema reads** outside `staging/`.
