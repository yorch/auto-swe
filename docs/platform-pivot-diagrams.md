# Platform Pivot — Architecture & Flow Diagrams

High-level diagrams for the platform pivot. Companion to the
[RFC & roadmap](./platform-pivot.md) and the [P0 epic](./platform-pivot-p0.md).
Every diagram here renders inline on GitHub (Mermaid). They reflect the decisions
landed so far:

- **mechanism vs. content** — the engine ships generic primitives; SWE ships as *seed content*;
- **agent resolution is snapshotted at run start** (reproducible; supersedes mid-run model edits);
- **coherence** = idempotent re-seed (reset) + write-time referential integrity now, dependency/version upgrades deferred to P4.

> Status: **Proposed** — tracks RFC rev. 3 (in draft). Diagrams are normative for *shape*, not
> for exact field names; the schema is authoritative where they diverge.

---

## 1. The pivot in one picture — mechanism vs. content

The core platform is generic. Everything SWE-specific becomes seeded, editable DB rows that sit
*on top of* the engine. The dotted line is the boundary the pivot enforces: nothing below it
knows what "software engineering" is.

```mermaid
flowchart TB
    subgraph content["SWE starter — seed content (origin='swe-starter', editable DB rows)"]
        direction LR
        c1["Coding Agents<br/>implementer · reviewer · planner"]
        c2["Templates<br/>standard-run · epic · CI-heal"]
        c3["Coding Skills<br/>27 built-ins"]
        c4["Code-security<br/>scanner patterns"]
        c5["Review network<br/>composition"]
    end

    subgraph engine["Core platform — mechanism (generic, no SWE knowledge)"]
        direction LR
        e1["Workflow engine<br/>JSON DAG on Temporal"]
        e2["Generic node types<br/>agent · fan-out · aggregation · shell-gate · HITL · memory"]
        e3["Libraries<br/>Agents · Templates · Skills · Connections"]
        e4["Cross-cutting scanners<br/>injection · exfil · shell · sensitive-file"]
        e5["Cost · budget · observability"]
    end

    content -.->|"composed from / configured over"| engine

    classDef contentBox fill:#fde68a,stroke:#b45309,color:#3b2a00;
    classDef engineBox fill:#bfdbfe,stroke:#1d4ed8,color:#0b1f4d;
    class c1,c2,c3,c4,c5 contentBox;
    class e1,e2,e3,e4,e5 engineBox;
```

---

## 2. Layered architecture

How the pieces stack. Libraries are the composition surface; the engine interprets templates and
dispatches steps; the runtime is unchanged from today (Temporal + Docker + Postgres/pgvector).

```mermaid
flowchart TB
    subgraph clients["Surfaces"]
        web["Web dashboard<br/>(Next.js)"]
        cli["CLI"]
        trig["Triggers / webhooks"]
    end

    gw["Gateway API (Fastify)<br/>auth · RBAC · library CRUD · work-requests"]

    subgraph libs["Libraries (versioned, governed catalogs)"]
        direction LR
        lAgents["Agents"]
        lTemplates["Templates"]
        lSkills["Skills"]
        lConns["Connections"]
    end

    subgraph eng["Workflow engine (worker)"]
        direction LR
        interp["Template interpreter"]
        registry["Step registry<br/>(dispatch seam)"]
        resolver["Config resolver<br/>(cascade + snapshot)"]
    end

    subgraph rt["Runtime"]
        direction LR
        temporal["Temporal<br/>(durable execution)"]
        docker["Docker workspaces<br/>(sandboxed steps)"]
        db["Postgres + pgvector<br/>(state · memory)"]
        scan["Security scanners"]
    end

    clients --> gw
    gw --> libs
    libs --> eng
    eng --> rt

    classDef l fill:#ddd6fe,stroke:#6d28d9,color:#2e1065;
    classDef e fill:#bfdbfe,stroke:#1d4ed8,color:#0b1f4d;
    classDef r fill:#bbf7d0,stroke:#15803d,color:#052e16;
    class lAgents,lTemplates,lSkills,lConns l;
    class interp,registry,resolver e;
    class temporal,docker,db,scan r;
```

---

## 3. Override cascade (config resolution)

Skills, tool configs, and **model/Agent bindings** all resolve through the same precedence chain.
The pivot adds a **per-run override** at the top and makes every layer able to **pin** (freeze a
version) or **float** (track latest).

```mermaid
flowchart TD
    start(["Resolve binding for an agentRef / skill / tool"]) --> run{"Per-run<br/>override?"}
    run -->|yes| use1["use it"]
    run -->|no| tmpl{"WORKFLOW_TEMPLATE<br/>override?"}
    tmpl -->|yes| use2["use it"]
    tmpl -->|no| team{"TEAM<br/>override?"}
    team -->|yes| use3["use it"]
    team -->|no| glob{"GLOBAL<br/>row?"}
    glob -->|yes| use4["use it"]
    glob -->|no| err["ConfigMissingError<br/>(no fallback past GLOBAL)"]

    use1 --> pin{"pinned<br/>version?"}
    use2 --> pin
    use3 --> pin
    use4 --> pin
    pin -->|"pinned"| frozen["exact version"]
    pin -->|"float"| latest["latest published version"]

    classDef hit fill:#bbf7d0,stroke:#15803d,color:#052e16;
    classDef miss fill:#fecaca,stroke:#b91c1c,color:#450a0a;
    class use1,use2,use3,use4,frozen,latest hit;
    class err miss;
```

---

## 4. Run lifecycle (end to end)

A trigger fires, the engine resolves and **snapshots** all references once, then interprets the
template DAG, dispatching each node through the step registry.

```mermaid
sequenceDiagram
    autonumber
    participant T as Trigger / Gateway
    participant W as Workflow (Temporal)
    participant R as Resolver
    participant Reg as Step registry → activities
    participant A as Agents
    participant G as GitHub

    T->>W: start run (template ref, inputs, team, per-run overrides)
    W->>R: resolve all agentRefs / skills / tools (cascade)
    R-->>W: specSnapshot (frozen)
    Note over W: snapshot persisted on WorkflowRun<br/>→ run is reproducible
    loop each node in template DAG
        W->>Reg: dispatch(stepName, args)
        Reg->>A: invoke agent(s) with snapshotted bindings
        A-->>Reg: result (+ traces, cost, scanner findings)
        Reg-->>W: step result
        Note over W: gates / aggregation / HITL may pause or branch
    end
    W->>G: open pull request
    W-->>T: run complete (awaiting human merge)
```

---

## 5. Agent resolution — snapshot at run start

The decision: resolve every `agentRef` **once** at run start and freeze the result into a
`specSnapshot` on the `WorkflowRun`. Steps read the snapshot, never the live library. This trades
the old mid-run model-edit behavior for full reproducibility.

```mermaid
flowchart LR
    subgraph t0["t0 — run start"]
        refs["Template agentRefs<br/>+ skills + tools"] --> casc["Cascade resolve<br/>(per-run→template→team→global)"]
        casc --> snap["specSnapshot<br/>(frozen on WorkflowRun)"]
    end

    subgraph during["during run"]
        step1["step A"] --> snap2["read snapshot"]
        step2["step B"] --> snap2
        step3["step N"] --> snap2
    end

    snap --> snap2

    edit["Library edit<br/>mid-run"] -. "ignored by this run<br/>(applies to next run)" .-> snap2

    classDef frozen fill:#bfdbfe,stroke:#1d4ed8,color:#0b1f4d;
    classDef ignore fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray: 4 3;
    class snap,snap2 frozen;
    class edit ignore;
```

---

## 6. SWE review network composed from generic primitives

The multi-agent review network is **not** a core feature — it's seed content assembled from three
generic node types. A second use case can build its own review fan-out with zero engine changes.

```mermaid
flowchart TB
    in["Code diff + context"] --> fo{{"fan-out node<br/>(core primitive)"}}
    fo --> r1["Agent: securityReviewer"]
    fo --> r2["Agent: domainLogicReviewer"]
    fo --> r3["Agent: performanceReviewer"]
    r1 --> agg{{"aggregation node<br/>(configurable policy:<br/>quorum / any-blocker / weighted)"}}
    r2 --> agg
    r3 --> agg
    agg --> gate{{"shell-gate node<br/>(core primitive)"}}
    gate -->|pass| out["proceed → PR"]
    gate -->|block| fix["back to implementer"]

    note["The 3 agents + the aggregation policy<br/>are SEED CONTENT (config).<br/>fan-out / aggregation / gate are MECHANISM."]:::n

    classDef core fill:#bfdbfe,stroke:#1d4ed8,color:#0b1f4d;
    classDef seed fill:#fde68a,stroke:#b45309,color:#3b2a00;
    classDef n fill:#fff,stroke:#9ca3af,color:#374151,stroke-dasharray: 3 3;
    class fo,agg,gate core;
    class r1,r2,r3 seed;
```

---

## 7. Connection model (generic external integration)

A **Connection** is one generic abstraction for everything external: triggers, input sources,
memory backends, and MCP tool servers. Adapters map a connector's events onto template inputs —
configuration, not code.

```mermaid
flowchart TB
    subgraph lib["Connection library (versioned, governed)"]
        conn["Connection<br/>(credentials + adapter config)"]
    end

    conn --> k1["as Trigger<br/>(events → start a run)"]
    conn --> k2["as Input source<br/>(fetch context at submit)"]
    conn --> k3["as Memory backend<br/>(read/write semantic store)"]
    conn --> k4["as MCP server (P3)<br/>(expose tools to agents)"]

    k1 --> map["Event→input adapter<br/>(config, no code)"]
    map --> run["Workflow run"]
    k2 --> run
    k3 -.-> run
    k4 -.-> run

    classDef c fill:#ddd6fe,stroke:#6d28d9,color:#2e1065;
    class conn,k1,k2,k3,k4 c;
```

---

## 8. Phase roadmap (P0–P5)

What each phase delivers and the dependency order. P0–P3 are committed; P4–P5 are deferred but
shape-compatible from day one.

```mermaid
flowchart LR
    p0["P0 — Decouple core<br/>enum→string · step registry<br/>computed assertReady · origin tags"]
    p1["P1 — Libraries<br/>Agents/Templates/Skills/Connections<br/>cascade + per-run override<br/>referential integrity"]
    p2["P2 — Generic nodes<br/>agentRef nodes · fan-out +<br/>configurable aggregation · gates"]
    p3["P3 — Connections<br/>generic triggers/inputs/memory<br/>MCP connections · event adapters"]
    p4["P4 — Distribution<br/>dependency graph · version-coherent<br/>upgrades · export/import bundles"]
    p5["P5 — UX / multi-org<br/>library marketplace · multi-tenant"]

    p0 --> p1 --> p2 --> p3 --> p4 --> p5

    classDef committed fill:#bbf7d0,stroke:#15803d,color:#052e16;
    classDef deferred fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray: 5 3;
    class p0,p1,p2,p3 committed;
    class p4,p5 deferred;
```

---

## 9. Coherence model (reset · integrity · drift · upgrade)

"Resettable SWE starter" does **not** require a dependency manifest. It decomposes into four
capabilities with very different costs — only the cheap ones are needed before P4.

```mermaid
flowchart TB
    defs["Seed definitions<br/>(source of truth, in code)"] -->|"idempotent upsert"| rows["origin='swe-starter' rows<br/>(editable in DB)"]

    rows --> reset["1 · Reset to starter<br/>= re-run seed (FREE, now)"]
    rows --> integ["2 · Referential integrity<br/>write-time agentRef/skillRef check<br/>(P1 — needed anyway)"]
    rows --> drift["3 · Drift detection<br/>per-row base hash compare<br/>(P1 — optional)"]
    rows --> upg["4 · Version-coherent upgrades<br/>dependency graph + bundle merge<br/>(P4 — deferred)"]

    classDef now fill:#bbf7d0,stroke:#15803d,color:#052e16;
    classDef soon fill:#fde68a,stroke:#b45309,color:#3b2a00;
    classDef later fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray: 5 3;
    class reset now;
    class integ,drift soon;
    class upg later;
```

---

## Legend

| Color | Meaning |
|---|---|
| 🟦 Blue | Core platform **mechanism** (generic engine) |
| 🟨 Amber | SWE **seed content** / near-term config work |
| 🟪 Purple | Libraries layer |
| 🟩 Green | Available now / committed / runtime |
| ⬜ Gray (dashed) | Deferred (P4–P5) or intentionally ignored |
