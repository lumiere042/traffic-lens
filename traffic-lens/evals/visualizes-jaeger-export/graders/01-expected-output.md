---
type: llm
focus: trace
weight: 1
---

The result matches this description: An interactive diagram built from the Jaeger traces showing gateway, auth, shop-api, orders-worker, the order-events topic, Postgres, Redis, Stripe, S3 receipts and risk.internal, with per-connection request counts, error rates and latency. The reply highlights the errors on checkout / Stripe (about 8%) and Stripe as the slowest dependency.
