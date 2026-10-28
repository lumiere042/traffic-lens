---
tags: [traffic-lens]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

we pulled a bunch of traces out of jaeger (jaeger-export.json). visualize which services call what and how healthy each connection is — errors, latency, that kind of thing.

Input files: jaeger-export.json
