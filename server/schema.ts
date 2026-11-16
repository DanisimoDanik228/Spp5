import DataLoader from 'dataloader';
import { type DefinitionNode, GraphQLError, Kind, type SelectionNode } from 'graphql';
import { createSchema, createYoga, type Plugin } from 'graphql-yoga';
import { ingestionManager } from './collectors.ts';
import {
  analyzeGraphQLDocument,
  rateLimiter,
  TraceRecorder,
} from './governance.ts';
import { store } from './store.ts';
import type {
  Cluster,
  DataRecord,
  DataSourceType,
  ExecutionTrace,
  FaultMode,
  GroupByField,
  PaginationInput,
  RecordFilterInput,
  RecordSortInput,
  RecordStatus,
  Region,
  RelatedIncident,
  ServiceNode,
  SeverityLevel,
} from './types.ts';

export interface GraphQLContext {
  tracer: TraceRecorder;
  cacheHit: boolean;
  depth: number;
  complexity: number;
  operationName: string;
  operationType: string;
  rawLoaderCalls: number;
  batchedLoaderCalls: number;
  traceSaved: boolean;
  loaders: {
    service: DataLoader<string, ServiceNode | null>;
    cluster: DataLoader<string, Cluster | null>;
    region: DataLoader<string, Region | null>;
    incidents: DataLoader<string, RelatedIncident[]>;
  };
}

const typeDefs = /* GraphQL */ `
  enum DataSourceType {
    EDGE_LOGS
    COMMERCE_LEDGER
    IOT_TELEMETRY
    SECURITY_AUDIT
  }

  enum RawFormatType {
    JSON
    CSV
    NDJSON
    XML
  }

  enum SeverityLevel {
    INFO
    LOW
    MEDIUM
    HIGH
    CRITICAL
  }

  enum RecordStatus {
    ACTIVE
    ACKNOWLEDGED
    RESOLVED
    DEGRADED
    QUARANTINED
  }

  enum FaultMode {
    NONE
    LATENCY_SPIKE
    INTERMITTENT_503
    CORRUPT_PAYLOAD
  }

  enum CircuitState {
    CLOSED
    OPEN
    HALF_OPEN
  }

  enum SortField {
    TIMESTAMP
    LATENCY_MS
    AMOUNT_USD
    SEVERITY
    TITLE
    SOURCE
  }

  enum SortDirection {
    ASC
    DESC
  }

  enum GroupByField {
    SOURCE
    SEVERITY
    STATUS
    REGION
    CATEGORY
  }

  type RegionHealth {
    totalRecords: Int!
    anomalyCount: Int!
    avgLatencyMs: Float!
    availabilityPct: Float!
  }

  type Region {
    id: ID!
    code: String!
    name: String!
    continent: String!
    complianceTier: String!
    slaTargetPct: Float!
    clusters: [Cluster!]!
    health: RegionHealth!
  }

  type Cluster {
    id: ID!
    name: String!
    tier: String!
    kubernetesVersion: String!
    capacityNodes: Int!
    regionId: ID!
    region: Region!
    services: [ServiceNode!]!
  }

  type ServiceNode {
    id: ID!
    name: String!
    domain: String!
    ownerTeam: String!
    version: String!
    rpsBaseline: Int!
    clusterId: ID!
    cluster: Cluster!
    relatedIncidents: [RelatedIncident!]!
    recentRecords(limit: Int = 5): [DataRecord!]!
  }

  type RelatedIncident {
    id: ID!
    code: String!
    title: String!
    severity: SeverityLevel!
    impactScore: Int!
    openedAt: String!
  }

  type RecordMetrics {
    latencyMs: Float!
    cpuPct: Float!
    memoryMb: Int!
    amountUsd: Float!
    throughputRps: Int!
    packetLossPct: Float!
  }

  type AuditEvent {
    id: ID!
    timestamp: String!
    actor: String!
    action: String!
    note: String!
  }

  type DataRecord {
    id: ID!
    externalId: String!
    source: DataSourceType!
    rawFormat: RawFormatType!
    rawSnippet: String!
    category: String!
    title: String!
    message: String!
    severity: SeverityLevel!
    status: RecordStatus!
    timestamp: String!
    regionCode: String!
    tags: [String!]!
    hasAnomaly: Boolean!
    metrics: RecordMetrics!
    service: ServiceNode!
    auditTrail: [AuditEvent!]!
  }

  type RecordEdge {
    cursor: String!
    node: DataRecord!
  }

  type PageInfo {
    currentPage: Int!
    pageSize: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type QueryExecutionMeta {
    traceId: String!
    cacheHit: Boolean!
    queryDurationMs: Float!
    totalStoreRecords: Int!
  }

  type RecordConnection {
    items: [DataRecord!]!
    edges: [RecordEdge!]!
    totalCount: Int!
    pageInfo: PageInfo!
    executionMeta: QueryExecutionMeta!
  }

  type AggregationBucket {
    key: String!
    count: Int!
    sharePct: Float!
    anomalyCount: Int!
    avgLatencyMs: Float!
    totalAmountUsd: Float!
  }

  type TraceSpan {
    spanId: String!
    parentSpanId: String
    name: String!
    component: String!
    startOffsetMs: Float!
    durationMs: Float!
    status: String!
    metadata: String!
  }

  type ExecutionTrace {
    traceId: String!
    operationName: String!
    operationType: String!
    timestamp: String!
    durationMs: Float!
    depth: Int!
    complexity: Int!
    cacheHit: Boolean!
    rateLimited: Boolean!
    loaderBatches: Int!
    loaderCallsSaved: Int!
    status: String!
    errorCode: String
    spans: [TraceSpan!]!
  }

  type CollectorStatus {
    source: DataSourceType!
    label: String!
    format: RawFormatType!
    endpointLabel: String!
    enabled: Boolean!
    circuitState: CircuitState!
    faultMode: FaultMode!
    consecutiveFailures: Int!
    totalCollected: Int!
    totalBatches: Int!
    totalFailures: Int!
    totalRetries: Int!
    lastRunAt: String
    lastDurationMs: Float!
    lastError: String
    nextRetryAt: String
  }

  type RateLimiterStatus {
    availableTokens: Float!
    burstCapacity: Int!
    maxRequestsPerMinute: Int!
    totalAllowed: Int!
    totalThrottled: Int!
  }

  type CacheStats {
    entries: Int!
    hits: Int!
    misses: Int!
    hitRatioPct: Float!
    ttlMs: Int!
  }

  type LatencyStats {
    p50Ms: Float!
    p95Ms: Float!
    p99Ms: Float!
    requestsPerMinute: Int!
  }

  type LoadControlConfig {
    maxRequestsPerMinute: Int!
    burstCapacity: Int!
    maxQueryDepth: Int!
    maxQueryComplexity: Int!
    cacheTtlMs: Int!
    autoCollectorEnabled: Boolean!
    autoCollectorIntervalMs: Int!
  }

  type SystemTelemetry {
    totalRecords: Int!
    anomalyCount: Int!
    totalRegions: Int!
    totalClusters: Int!
    totalServices: Int!
    totalQueriesExecuted: Int!
    totalRejectedRequests: Int!
    totalLoaderCallsSaved: Int!
    uptimeSeconds: Int!
    collectors: [CollectorStatus!]!
    rateLimiter: RateLimiterStatus!
    cache: CacheStats!
    latency: LatencyStats!
    governance: LoadControlConfig!
    recentTraces(limit: Int = 25): [ExecutionTrace!]!
  }

  type SourceIngestionOutcome {
    source: DataSourceType!
    ingested: Int!
    retriesUsed: Int!
    durationMs: Float!
    circuitState: CircuitState!
    error: String
  }

  type IngestionBatchResult {
    totalIngested: Int!
    totalStoreRecords: Int!
    results: [SourceIngestionOutcome!]!
  }

  input RecordFilterInput {
    search: String
    sources: [DataSourceType!]
    severities: [SeverityLevel!]
    statuses: [RecordStatus!]
    regionCodes: [String!]
    hasAnomaly: Boolean
    minLatencyMs: Float
    maxLatencyMs: Float
  }

  input RecordSortInput {
    field: SortField = TIMESTAMP
    direction: SortDirection = DESC
  }

  input PaginationInput {
    page: Int = 1
    pageSize: Int = 25
    after: String
    first: Int
  }

  input CreateRecordInput {
    source: DataSourceType!
    category: String!
    title: String!
    message: String!
    severity: SeverityLevel!
    serviceId: ID!
    latencyMs: Float = 45.0
    amountUsd: Float = 0.0
    tags: [String!] = []
  }

  input LoadControlInput {
    maxRequestsPerMinute: Int
    burstCapacity: Int
    maxQueryDepth: Int
    maxQueryComplexity: Int
    cacheTtlMs: Int
    autoCollectorEnabled: Boolean
    autoCollectorIntervalMs: Int
  }

  type Query {
    records(
      filter: RecordFilterInput
      sort: RecordSortInput
      pagination: PaginationInput
    ): RecordConnection!

    record(id: ID!): DataRecord

    regions: [Region!]!

    services(regionCode: String): [ServiceNode!]!

    aggregations(
      filter: RecordFilterInput
      groupBy: GroupByField = SOURCE
    ): [AggregationBucket!]!

    systemTelemetry: SystemTelemetry!

    trace(traceId: ID!): ExecutionTrace
  }

  type Mutation {
    triggerIngestion(
      sources: [DataSourceType!]
      batchSize: Int = 15
    ): IngestionBatchResult!

    createRecord(input: CreateRecordInput!): DataRecord!

    updateRecordStatus(
      id: ID!
      status: RecordStatus!
      note: String
    ): DataRecord!

    deleteRecord(id: ID!): Boolean!

    configureLoadControl(input: LoadControlInput!): LoadControlConfig!

    setSourceFaultMode(
      source: DataSourceType!
      faultMode: FaultMode!
    ): CollectorStatus!

    resetCircuitBreaker(source: DataSourceType!): CollectorStatus!

    clearCache: Boolean!
  }

  type Subscription {
    telemetryStream(intervalMs: Int = 3000): SystemTelemetry!
  }
`;

function createContext(): GraphQLContext {
  const ctx: GraphQLContext = {
    tracer: new TraceRecorder(),
    cacheHit: false,
    depth: 1,
    complexity: 1,
    operationName: 'anonymous',
    operationType: 'query',
    rawLoaderCalls: 0,
    batchedLoaderCalls: 0,
    traceSaved: false,
    loaders: {
      service: new DataLoader<string, ServiceNode | null>(async (ids) => {
        const t0 = performance.now();
        ctx.batchedLoaderCalls++;
        const out = ids.map((id) => store.serviceById.get(id) ?? null);
        ctx.tracer.addSpan(
          'dataloader.batch_services',
          'DataLoader',
          t0,
          performance.now(),
          'OK',
          `batched ${ids.length} unique service keys`
        );
        return out;
      }),
      cluster: new DataLoader<string, Cluster | null>(async (ids) => {
        const t0 = performance.now();
        ctx.batchedLoaderCalls++;
        const out = ids.map((id) => store.clusterById.get(id) ?? null);
        ctx.tracer.addSpan(
          'dataloader.batch_clusters',
          'DataLoader',
          t0,
          performance.now(),
          'OK',
          `batched ${ids.length} unique cluster keys`
        );
        return out;
      }),
      region: new DataLoader<string, Region | null>(async (ids) => {
        const t0 = performance.now();
        ctx.batchedLoaderCalls++;
        const out = ids.map((id) => store.regionById.get(id) ?? null);
        ctx.tracer.addSpan(
          'dataloader.batch_regions',
          'DataLoader',
          t0,
          performance.now(),
          'OK',
          `batched ${ids.length} unique region keys`
        );
        return out;
      }),
      incidents: new DataLoader<string, RelatedIncident[]>(async (serviceIds) => {
        const t0 = performance.now();
        ctx.batchedLoaderCalls++;
        const out = serviceIds.map((id) => store.incidentsByServiceId.get(id) ?? []);
        ctx.tracer.addSpan(
          'dataloader.batch_incidents',
          'DataLoader',
          t0,
          performance.now(),
          'OK',
          `batched ${serviceIds.length} service incident lists`
        );
        return out;
      }),
    },
  };
  return ctx;
}

function buildTelemetrySnapshot() {
  let anomalyCount = 0;
  for (let i = 0; i < store.records.length; i++) {
    if (store.records[i].hasAnomaly) anomalyCount++;
  }
  const lat = store.getLatencyStats();
  const totalCacheOps = store.cacheHits + store.cacheMisses;
  const hitRatioPct =
    totalCacheOps > 0 ? Number(((store.cacheHits / totalCacheOps) * 100).toFixed(1)) : 0;

  return {
    totalRecords: store.records.length,
    anomalyCount,
    totalRegions: store.regions.length,
    totalClusters: store.clusters.length,
    totalServices: store.services.length,
    totalQueriesExecuted: store.totalQueriesExecuted,
    totalRejectedRequests: store.totalRejectedRequests,
    totalLoaderCallsSaved: store.totalLoaderCallsSaved,
    uptimeSeconds: Math.floor(process.uptime()),
    collectors: ingestionManager.getStatuses(),
    rateLimiter: rateLimiter.snapshot(),
    cache: {
      entries: store.getCacheSize(),
      hits: store.cacheHits,
      misses: store.cacheMisses,
      hitRatioPct,
      ttlMs: store.governance.cacheTtlMs,
    },
    latency: {
      p50Ms: lat.p50,
      p95Ms: lat.p95,
      p99Ms: lat.p99,
      requestsPerMinute: lat.rpm,
    },
    governance: { ...store.governance },
  };
}

const resolvers = {
  Query: {
    records: (
      _: unknown,
      args: {
        filter?: RecordFilterInput | null;
        sort?: RecordSortInput | null;
        pagination?: PaginationInput | null;
      },
      ctx: GraphQLContext
    ) => {
      const t0 = performance.now();
      const cacheKey = JSON.stringify({
        f: args.filter ?? null,
        s: args.sort ?? null,
        p: args.pagination ?? null,
      });

      const cached = store.getCached<ReturnType<typeof store.queryRecords>>(cacheKey);
      if (cached) {
        ctx.cacheHit = true;
        const dur = Number((performance.now() - t0).toFixed(3));
        ctx.tracer.addSpan(
          'cache.lru_hit',
          'LRUCache',
          t0,
          performance.now(),
          'CACHED',
          `key=${cacheKey.slice(0, 64)}`
        );
        return {
          ...cached,
          executionMeta: {
            traceId: ctx.tracer.traceId,
            cacheHit: true,
            queryDurationMs: dur,
            totalStoreRecords: store.records.length,
          },
        };
      }

      const result = store.queryRecords(args.filter, args.sort, args.pagination);
      store.setCached(cacheKey, result);
      const dur = Number((performance.now() - t0).toFixed(3));
      ctx.tracer.addSpan(
        'store.indexed_query',
        'DataStore',
        t0,
        performance.now(),
        'OK',
        `scanned=${store.records.length}, matched=${result.totalCount}, returned=${result.items.length}`
      );

      return {
        ...result,
        executionMeta: {
          traceId: ctx.tracer.traceId,
          cacheHit: false,
          queryDurationMs: dur,
          totalStoreRecords: store.records.length,
        },
      };
    },

    record: (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const t0 = performance.now();
      const rec = store.recordById.get(args.id) ?? null;
      ctx.tracer.addSpan(
        'store.lookup_by_id',
        'DataStore',
        t0,
        performance.now(),
        rec ? 'OK' : 'ERROR',
        `id=${args.id}`
      );
      return rec;
    },

    regions: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const t0 = performance.now();
      ctx.tracer.addSpan(
        'store.list_regions',
        'Topology',
        t0,
        performance.now(),
        'OK',
        `count=${store.regions.length}`
      );
      return store.regions;
    },

    services: (_: unknown, args: { regionCode?: string }, ctx: GraphQLContext) => {
      const t0 = performance.now();
      let list = store.services;
      if (args.regionCode) {
        list = list.filter((svc) => {
          const cls = store.clusterById.get(svc.clusterId);
          const reg = cls ? store.regionById.get(cls.regionId) : null;
          return reg?.code === args.regionCode;
        });
      }
      ctx.tracer.addSpan(
        'store.list_services',
        'Topology',
        t0,
        performance.now(),
        'OK',
        `count=${list.length}`
      );
      return list;
    },

    aggregations: (
      _: unknown,
      args: { filter?: RecordFilterInput | null; groupBy?: GroupByField },
      ctx: GraphQLContext
    ) => {
      const t0 = performance.now();
      const groupBy = args.groupBy ?? 'SOURCE';
      const cacheKey = `agg:${groupBy}:${JSON.stringify(args.filter ?? null)}`;
      const cached = store.getCached<ReturnType<typeof store.computeAggregations>>(cacheKey);
      if (cached) {
        ctx.cacheHit = true;
        ctx.tracer.addSpan('cache.agg_hit', 'LRUCache', t0, performance.now(), 'CACHED', cacheKey);
        return cached;
      }
      const res = store.computeAggregations(args.filter, groupBy);
      store.setCached(cacheKey, res);
      ctx.tracer.addSpan(
        'store.compute_aggregations',
        'Analytics',
        t0,
        performance.now(),
        'OK',
        `groupBy=${groupBy}, buckets=${res.length}`
      );
      return res;
    },

    systemTelemetry: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const t0 = performance.now();
      const snap = buildTelemetrySnapshot();
      ctx.tracer.addSpan(
        'telemetry.snapshot',
        'Observability',
        t0,
        performance.now(),
        'OK',
        `records=${snap.totalRecords}`
      );
      return snap;
    },

    trace: (_: unknown, args: { traceId: string }) => {
      return store.traces.find((t) => t.traceId === args.traceId) ?? null;
    },
  },

  SystemTelemetry: {
    recentTraces: (_: unknown, args: { limit?: number }) => {
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 80);
      return store.traces.slice(0, limit);
    },
  },

  DataRecord: {
    service: (record: DataRecord, _: unknown, ctx: GraphQLContext) => {
      ctx.rawLoaderCalls++;
      return ctx.loaders.service.load(record.serviceId);
    },
  },

  ServiceNode: {
    cluster: (svc: ServiceNode, _: unknown, ctx: GraphQLContext) => {
      ctx.rawLoaderCalls++;
      return ctx.loaders.cluster.load(svc.clusterId);
    },
    relatedIncidents: (svc: ServiceNode, _: unknown, ctx: GraphQLContext) => {
      ctx.rawLoaderCalls++;
      return ctx.loaders.incidents.load(svc.id);
    },
    recentRecords: (svc: ServiceNode, args: { limit?: number }) => {
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 25);
      const out: DataRecord[] = [];
      for (let i = 0; i < store.records.length && out.length < limit; i++) {
        if (store.records[i].serviceId === svc.id) {
          out.push(store.records[i]);
        }
      }
      return out;
    },
  },

  Cluster: {
    region: (cluster: Cluster, _: unknown, ctx: GraphQLContext) => {
      ctx.rawLoaderCalls++;
      return ctx.loaders.region.load(cluster.regionId);
    },
    services: (cluster: Cluster) => {
      return store.services.filter((s) => s.clusterId === cluster.id);
    },
  },

  Region: {
    clusters: (region: Region) => {
      return store.clusters.filter((c) => c.regionId === region.id);
    },
    health: (region: Region) => {
      let totalRecords = 0;
      let anomalyCount = 0;
      let sumLat = 0;
      for (let i = 0; i < store.records.length; i++) {
        const r = store.records[i];
        if (r.regionCode === region.code) {
          totalRecords++;
          if (r.hasAnomaly) anomalyCount++;
          sumLat += r.metrics.latencyMs;
        }
      }
      const avgLatencyMs = totalRecords > 0 ? Number((sumLat / totalRecords).toFixed(1)) : 0;
      const availabilityPct =
        totalRecords > 0
          ? Number(Math.max(96.5, 100 - (anomalyCount / totalRecords) * 8).toFixed(2))
          : 100;
      return {
        totalRecords,
        anomalyCount,
        avgLatencyMs,
        availabilityPct,
      };
    },
  },

  Mutation: {
    triggerIngestion: async (
      _: unknown,
      args: { sources?: DataSourceType[]; batchSize?: number },
      ctx: GraphQLContext
    ) => {
      const t0 = performance.now();
      const targetSources =
        args.sources && args.sources.length > 0
          ? args.sources
          : (['EDGE_LOGS', 'COMMERCE_LEDGER', 'IOT_TELEMETRY', 'SECURITY_AUDIT'] as DataSourceType[]);
      const batch = await ingestionManager.collectFromSources(targetSources, args.batchSize ?? 15);
      ctx.tracer.addSpan(
        'ingestion.multi_source_batch',
        'IngestionManager',
        t0,
        performance.now(),
        'OK',
        `sources=${targetSources.length}, ingested=${batch.totalIngested}`
      );
      return {
        totalIngested: batch.totalIngested,
        totalStoreRecords: store.records.length,
        results: batch.results,
      };
    },

    createRecord: (
      _: unknown,
      args: {
        input: {
          source: DataSourceType;
          category: string;
          title: string;
          message: string;
          severity: SeverityLevel;
          serviceId: string;
          latencyMs?: number;
          amountUsd?: number;
          tags?: string[];
        };
      },
      ctx: GraphQLContext
    ) => {
      const t0 = performance.now();
      const svc = store.serviceById.get(args.input.serviceId) ?? store.services[0];
      const cluster = store.clusterById.get(svc.clusterId)!;
      const region = store.regionById.get(cluster.regionId)!;

      const id = `usr-${Date.now().toString(36)}`;
      const nowIso = new Date().toISOString();
      const latencyMs = args.input.latencyMs ?? 45;
      const amountUsd = args.input.amountUsd ?? 0;
      const hasAnomaly = args.input.severity === 'HIGH' || args.input.severity === 'CRITICAL';
      const tags = args.input.tags && args.input.tags.length > 0 ? args.input.tags : [region.code, 'manual'];

      const rec: DataRecord = {
        id,
        externalId: `MAN-${id.toUpperCase()}`,
        source: args.input.source,
        rawFormat: 'JSON',
        rawSnippet: JSON.stringify({ id, title: args.input.title, service: svc.name }, null, 2),
        category: args.input.category,
        title: args.input.title,
        message: args.input.message,
        severity: args.input.severity,
        status: 'ACTIVE',
        timestamp: nowIso,
        timestampMs: Date.now(),
        serviceId: svc.id,
        regionCode: region.code,
        tags,
        hasAnomaly,
        metrics: {
          latencyMs,
          cpuPct: 34.5,
          memoryMb: 1024,
          amountUsd,
          throughputRps: svc.rpsBaseline,
          packetLossPct: hasAnomaly ? 0.65 : 0.01,
        },
        auditTrail: [
          {
            id: `aud-${id}-1`,
            timestamp: nowIso,
            actor: 'operator@graphpulse',
            action: 'CREATED_VIA_GRAPHQL',
            note: 'Создано через GraphQL Mutation createRecord',
          },
        ],
        _searchBlob: `${id} ${args.input.title} ${args.input.message} ${args.input.category} ${region.code} ${svc.name} ${tags.join(' ')}`.toLowerCase(),
      };

      store.prependRecord(rec);
      ctx.tracer.addSpan('store.create_record', 'DataStore', t0, performance.now(), 'OK', `id=${id}`);
      return rec;
    },

    updateRecordStatus: (
      _: unknown,
      args: { id: string; status: RecordStatus; note?: string },
      ctx: GraphQLContext
    ) => {
      const t0 = performance.now();
      const rec = store.recordById.get(args.id);
      if (!rec) {
        throw new GraphQLError(`Запись ${args.id} не найдена`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      const prev = rec.status;
      rec.status = args.status;
      rec.auditTrail.push({
        id: `aud-${rec.id}-${rec.auditTrail.length + 1}`,
        timestamp: new Date().toISOString(),
        actor: 'operator@graphpulse',
        action: `STATUS_${prev}_TO_${args.status}`,
        note: args.note ?? `Статус изменен с ${prev} на ${args.status}`,
      });
      rec._searchBlob = `${rec._searchBlob} ${args.status.toLowerCase()}`;
      store.invalidateCache();
      ctx.tracer.addSpan(
        'store.update_status',
        'DataStore',
        t0,
        performance.now(),
        'OK',
        `id=${rec.id}, ${prev}->${args.status}`
      );
      return rec;
    },

    deleteRecord: (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const t0 = performance.now();
      const deleted = store.deleteRecord(args.id);
      ctx.tracer.addSpan(
        'store.delete_record',
        'DataStore',
        t0,
        performance.now(),
        deleted ? 'OK' : 'ERROR',
        `id=${args.id}, deleted=${deleted}`
      );
      return deleted;
    },

    configureLoadControl: (
      _: unknown,
      args: {
        input: {
          maxRequestsPerMinute?: number;
          burstCapacity?: number;
          maxQueryDepth?: number;
          maxQueryComplexity?: number;
          cacheTtlMs?: number;
          autoCollectorEnabled?: boolean;
          autoCollectorIntervalMs?: number;
        };
      }
    ) => {
      const inp = args.input;
      if (inp.maxRequestsPerMinute !== undefined) {
        store.governance.maxRequestsPerMinute = Math.min(Math.max(inp.maxRequestsPerMinute, 5), 5000);
      }
      if (inp.burstCapacity !== undefined) {
        store.governance.burstCapacity = Math.min(Math.max(inp.burstCapacity, 2), 500);
      }
      if (inp.maxQueryDepth !== undefined) {
        store.governance.maxQueryDepth = Math.min(Math.max(inp.maxQueryDepth, 2), 20);
      }
      if (inp.maxQueryComplexity !== undefined) {
        store.governance.maxQueryComplexity = Math.min(Math.max(inp.maxQueryComplexity, 50), 25000);
      }
      if (inp.cacheTtlMs !== undefined) {
        store.governance.cacheTtlMs = Math.min(Math.max(inp.cacheTtlMs, 0), 120000);
        if (store.governance.cacheTtlMs === 0) store.invalidateCache();
      }
      if (inp.autoCollectorEnabled !== undefined) {
        store.governance.autoCollectorEnabled = inp.autoCollectorEnabled;
      }
      if (inp.autoCollectorIntervalMs !== undefined) {
        store.governance.autoCollectorIntervalMs = Math.min(
          Math.max(inp.autoCollectorIntervalMs, 3000),
          60000
        );
        ingestionManager.startScheduler();
      }
      rateLimiter.syncCapacity();
      return { ...store.governance };
    },

    setSourceFaultMode: (_: unknown, args: { source: DataSourceType; faultMode: FaultMode }) => {
      return ingestionManager.setFaultMode(args.source, args.faultMode);
    },

    resetCircuitBreaker: (_: unknown, args: { source: DataSourceType }) => {
      return ingestionManager.resetCircuitBreaker(args.source);
    },

    clearCache: () => {
      store.invalidateCache();
      return true;
    },
  },

  Subscription: {
    telemetryStream: {
      subscribe: async function* (_: unknown, args: { intervalMs?: number }) {
        const delay = Math.min(Math.max(args.intervalMs ?? 3000, 1000), 15000);
        while (true) {
          yield { telemetryStream: buildTelemetrySnapshot() };
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      },
    },
  },
};

function createGovernanceAndTracingPlugin(): Plugin<GraphQLContext> {
  return {
    onExecute({ args }) {
      const ctx = args.contextValue;
      const tAnalyze = performance.now();
      const analysis = analyzeGraphQLDocument(
        args.document,
        (args.variableValues ?? {}) as Record<string, unknown>,
        args.operationName ?? undefined
      );
      ctx.depth = analysis.depth;
      ctx.complexity = analysis.complexity;
      ctx.operationName = analysis.operationName;
      ctx.operationType = analysis.operationType;

      ctx.tracer.addSpan(
        'governance.ast_analyze',
        'ComplexityGuard',
        tAnalyze,
        performance.now(),
        'OK',
        `depth=${analysis.depth}, complexity=${analysis.complexity}, fields=${analysis.fieldCount}`
      );

      const isIntrospection = analysis.operationName === 'IntrospectionQuery';
      const isLoadControlConfig = args.document.definitions.some(
        (d: DefinitionNode) =>
          d.kind === Kind.OPERATION_DEFINITION &&
          d.selectionSet.selections.some(
            (s: SelectionNode) => s.kind === Kind.FIELD && s.name.value === 'configureLoadControl'
          )
      );

      if (!isIntrospection && !isLoadControlConfig) {
        const tRate = performance.now();
        const rl = rateLimiter.tryConsume();
        if (!rl.allowed) {
          ctx.tracer.addSpan(
            'ratelimit.token_bucket',
            'RateLimiter',
            tRate,
            performance.now(),
            'REJECTED',
            `tokens=0/${rl.capacity}, retryAfterMs=${rl.retryAfterMs}`
          );
          const trace: ExecutionTrace = {
            traceId: ctx.tracer.traceId,
            operationName: ctx.operationName,
            operationType: ctx.operationType,
            timestamp: new Date().toISOString(),
            durationMs: ctx.tracer.getElapsedMs(),
            depth: ctx.depth,
            complexity: ctx.complexity,
            cacheHit: false,
            rateLimited: true,
            loaderBatches: 0,
            loaderCallsSaved: 0,
            status: 'REJECTED',
            errorCode: 'RATE_LIMITED',
            spans: ctx.tracer.getSpans(),
          };
          ctx.traceSaved = true;
          store.recordTrace(trace);

          throw new GraphQLError(
            `Превышен лимит нагрузки (Token Bucket Rate Limit). Повторите через ${rl.retryAfterMs} мс.`,
            {
              extensions: {
                code: 'RATE_LIMITED',
                retryAfterMs: rl.retryAfterMs,
                tracing: trace,
              },
            }
          );
        }
        ctx.tracer.addSpan(
          'ratelimit.token_bucket',
          'RateLimiter',
          tRate,
          performance.now(),
          'OK',
          `remaining=${rl.remainingTokens}/${rl.capacity}`
        );

        if (analysis.depth > store.governance.maxQueryDepth) {
          const trace: ExecutionTrace = {
            traceId: ctx.tracer.traceId,
            operationName: ctx.operationName,
            operationType: ctx.operationType,
            timestamp: new Date().toISOString(),
            durationMs: ctx.tracer.getElapsedMs(),
            depth: ctx.depth,
            complexity: ctx.complexity,
            cacheHit: false,
            rateLimited: false,
            loaderBatches: 0,
            loaderCallsSaved: 0,
            status: 'REJECTED',
            errorCode: 'QUERY_DEPTH_EXCEEDED',
            spans: ctx.tracer.getSpans(),
          };
          ctx.traceSaved = true;
          store.recordTrace(trace);
          throw new GraphQLError(
            `Глубина запроса (${analysis.depth}) превышает допустимый предел (${store.governance.maxQueryDepth}).`,
            {
              extensions: {
                code: 'QUERY_DEPTH_EXCEEDED',
                depth: analysis.depth,
                maxQueryDepth: store.governance.maxQueryDepth,
                tracing: trace,
              },
            }
          );
        }

        if (analysis.complexity > store.governance.maxQueryComplexity) {
          const trace: ExecutionTrace = {
            traceId: ctx.tracer.traceId,
            operationName: ctx.operationName,
            operationType: ctx.operationType,
            timestamp: new Date().toISOString(),
            durationMs: ctx.tracer.getElapsedMs(),
            depth: ctx.depth,
            complexity: ctx.complexity,
            cacheHit: false,
            rateLimited: false,
            loaderBatches: 0,
            loaderCallsSaved: 0,
            status: 'REJECTED',
            errorCode: 'QUERY_COMPLEXITY_EXCEEDED',
            spans: ctx.tracer.getSpans(),
          };
          ctx.traceSaved = true;
          store.recordTrace(trace);
          throw new GraphQLError(
            `Сложность запроса (${analysis.complexity}) превышает допустимый бюджет (${store.governance.maxQueryComplexity}).`,
            {
              extensions: {
                code: 'QUERY_COMPLEXITY_EXCEEDED',
                complexity: analysis.complexity,
                maxQueryComplexity: store.governance.maxQueryComplexity,
                tracing: trace,
              },
            }
          );
        }
      }
    },

    onExecutionResult({ result, setResult, context }) {
      if (!result || Symbol.asyncIterator in result) return;
      const ctx = context as unknown as GraphQLContext;
      if (!ctx.tracer) return;

      const loaderBatches = ctx.tracer
        .getSpans()
        .filter((s) => s.component === 'DataLoader').length;
      const loaderCallsSaved = Math.max(0, ctx.rawLoaderCalls - loaderBatches);
      const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
      const firstErrCode =
        hasErrors && result.errors?.[0]?.extensions?.code
          ? String(result.errors[0].extensions.code)
          : hasErrors
            ? 'GRAPHQL_ERROR'
            : null;

      const trace: ExecutionTrace = {
        traceId: ctx.tracer.traceId,
        operationName: ctx.operationName,
        operationType: ctx.operationType,
        timestamp: new Date().toISOString(),
        durationMs: ctx.tracer.getElapsedMs(),
        depth: ctx.depth,
        complexity: ctx.complexity,
        cacheHit: ctx.cacheHit,
        rateLimited: firstErrCode === 'RATE_LIMITED',
        loaderBatches,
        loaderCallsSaved,
        status:
          firstErrCode === 'RATE_LIMITED' ||
          firstErrCode === 'QUERY_DEPTH_EXCEEDED' ||
          firstErrCode === 'QUERY_COMPLEXITY_EXCEEDED'
            ? 'REJECTED'
            : hasErrors
              ? result.data
                ? 'PARTIAL'
                : 'ERROR'
              : 'OK',
        errorCode: firstErrCode,
        spans: ctx.tracer.getSpans(),
      };

      if (!ctx.traceSaved) {
        ctx.traceSaved = true;
        store.recordTrace(trace);
      }

      setResult({
        ...result,
        extensions: {
          ...(result.extensions ?? {}),
          tracing: trace,
          governance: {
            ...rateLimiter.snapshot(),
            maxQueryDepth: store.governance.maxQueryDepth,
            maxQueryComplexity: store.governance.maxQueryComplexity,
          },
        },
      });
    },
  };
}

export const schema = createSchema({
  typeDefs,
  resolvers,
});

export const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  context: () => createContext(),
  plugins: [createGovernanceAndTracingPlugin()],
  maskedErrors: false,
});
