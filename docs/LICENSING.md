# Licensing FAQ

Open Profiling Agent uses a deliberate **split license**:

| Component | License | Rationale |
|-----------|---------|-----------|
| Collector (`OPA-Agent`), Dashboard, PHP extension, stack packaging | **EUPL-1.2** | Copyleft for the self-hosted core — improvements to the platform stay shareable |
| Language SDKs (`opa-node`, `opa-python`, `opa-rum-js`) | **MIT** | Permissive embedding so applications can instrument without license friction |

## Instrumenting a closed-source application

**Yes, that is fine.** Linking or calling an MIT SDK from proprietary code does not require open-sourcing your application. Shipping telemetry *to* an EUPL collector you run yourself also does not force your application code under EUPL.

## Running a modified collector

If you distribute a modified EUPL component (agent, dashboard, PHP extension), EUPL obligations apply to that distributed Work — typically providing source under EUPL (or a compatible license). See the EUPL text in each EUPL repo's `LICENSE`.

## Trademark / name

"Open Profiling Agent" / "OPA" refers to this project. Avoid implying endorsement by unrelated "OPA" projects (e.g. Open Policy Agent) in marketing materials.
