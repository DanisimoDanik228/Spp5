import type {
  Cluster,
  DataRecord,
  DataSourceType,
  ExecutionTrace,
  GroupByField,
  LoadControlConfig,
  PaginationInput,
  RecordFilterInput,
  RecordSortInput,
  Region,
  RelatedIncident,
  ServiceNode,
  SeverityLevel,
} from './types.ts';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessedAt: number;
}

const SEVERITY_WEIGHT: Record<SeverityLevel, number> = {
  INFO: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  CRITICAL: 5,
};

export class DataStore {
  public readonly regions: Region[] = [
    {
      id: 'reg-eu-central',
      code: 'eu-central-1',
      name: 'Франкфурт (EU Central)',
      continent: 'Европа',
      complianceTier: 'GDPR-Strict',
      slaTargetPct: 99.99,
    },
    {
      id: 'reg-eu-north',
      code: 'eu-north-1',
      name: 'Стокгольм (EU North)',
      continent: 'Европа',
      complianceTier: 'ISO-27001',
      slaTargetPct: 99.95,
    },
    {
      id: 'reg-us-east',
      code: 'us-east-1',
      name: 'Вирджиния (US East)',
      continent: 'Северная Америка',
      complianceTier: 'SOC2-Type2',
      slaTargetPct: 99.99,
    },
    {
      id: 'reg-us-west',
      code: 'us-west-2',
      name: 'Орегон (US West)',
      continent: 'Северная Америка',
      complianceTier: 'FedRAMP',
      slaTargetPct: 99.95,
    },
    {
      id: 'reg-ap-northeast',
      code: 'ap-northeast-1',
      name: 'Токио (AP Northeast)',
      continent: 'Азия',
      complianceTier: 'ISMAP',
      slaTargetPct: 99.98,
    },
    {
      id: 'reg-sa-east',
      code: 'sa-east-1',
      name: 'Сан-Паулу (SA East)',
      continent: 'Южная Америка',
      complianceTier: 'LGPD',
      slaTargetPct: 99.9,
    },
  ];

  public readonly clusters: Cluster[] = [];
  public readonly services: ServiceNode[] = [];
  public readonly incidents: RelatedIncident[] = [];

  public readonly regionById = new Map<string, Region>();
  public readonly clusterById = new Map<string, Cluster>();
  public readonly serviceById = new Map<string, ServiceNode>();
  public readonly incidentsByServiceId = new Map<string, RelatedIncident[]>();

  public records: DataRecord[] = [];
  public readonly recordById = new Map<string, DataRecord>();

  public readonly traces: ExecutionTrace[] = [];
  private readonly latencySamples: number[] = [];
  private readonly requestTimestamps: number[] = [];

  private readonly cache = new Map<string, CacheEntry<unknown>>();
  public cacheHits = 0;
  public cacheMisses = 0;
  private readonly maxCacheEntries = 120;

  public totalLoaderCallsSaved = 0;
  public totalQueriesExecuted = 0;
  public totalRejectedRequests = 0;

  public governance: LoadControlConfig = {
    maxRequestsPerMinute: 120,
    burstCapacity: 30,
    maxQueryDepth: 7,
    maxQueryComplexity: 1800,
    cacheTtlMs: 12000,
    autoCollectorEnabled: true,
    autoCollectorIntervalMs: 8000,
  };

  constructor() {
    this.initTopology();
  }

  private initTopology(): void {
    for (const region of this.regions) {
      this.regionById.set(region.id, region);
    }

    const clusterTiers = ['production-core', 'edge-ingress', 'analytics-mesh'];
    const k8sVersions = ['1.30.4', '1.31.1', '1.30.8'];

    let clusterIdx = 1;
    for (const region of this.regions) {
      for (let i = 0; i < 3; i++) {
        const cluster: Cluster = {
          id: `cls-${clusterIdx}`,
          name: `${region.code}-${clusterTiers[i]}`,
          tier: clusterTiers[i],
          kubernetesVersion: k8sVersions[i],
          capacityNodes: 16 + ((clusterIdx * 7) % 48),
          regionId: region.id,
        };
        this.clusters.push(cluster);
        this.clusterById.set(cluster.id, cluster);
        clusterIdx++;
      }
    }

    const serviceTemplates = [
      { name: 'gateway-proxy', domain: 'Edge Networking', team: 'Platform Net' },
      { name: 'checkout-ledger', domain: 'Commerce Core', team: 'Payments' },
      { name: 'telemetry-ingestor', domain: 'IoT Fabric', team: 'Observability' },
      { name: 'auth-policy-guard', domain: 'Zero Trust', team: 'SecOps' },
      { name: 'pricing-calculator', domain: 'Commerce Core', team: 'Revenue Eng' },
      { name: 'sensor-stream-hub', domain: 'IoT Fabric', team: 'Hardware Ops' },
      { name: 'waf-inspector', domain: 'Zero Trust', team: 'SecOps' },
      { name: 'graphql-federation', domain: 'API Mesh', team: 'Core API' },
    ];

    let svcIdx = 1;
    for (const cluster of this.clusters) {
      for (let i = 0; i < 3; i++) {
        const tpl = serviceTemplates[(svcIdx + i) % serviceTemplates.length];
        const svc: ServiceNode = {
          id: `svc-${svcIdx}`,
          name: `${tpl.name}-${String(svcIdx).padStart(2, '0')}`,
          domain: tpl.domain,
          ownerTeam: tpl.team,
          version: `v2.${(svcIdx % 9) + 1}.${(svcIdx * 3) % 15}`,
          rpsBaseline: 350 + ((svcIdx * 137) % 4200),
          clusterId: cluster.id,
        };
        this.services.push(svc);
        this.serviceById.set(svc.id, svc);

        const incidentCount = (svcIdx % 3) + 1;
        const svcIncidents: RelatedIncident[] = [];
        for (let k = 0; k < incidentCount; k++) {
          const sevOptions: SeverityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
          const inc: RelatedIncident = {
            id: `inc-${svcIdx}-${k + 1}`,
            code: `INC-${4000 + svcIdx * 10 + k}`,
            title:
              k === 0
                ? `Деградация хвостовой задержки на узле ${svc.name}`
                : `Всплеск повторных подключений в ${cluster.name}`,
            severity: sevOptions[(svcIdx + k) % sevOptions.length],
            impactScore: 15 + ((svcIdx * 13 + k * 19) % 85),
            serviceId: svc.id,
            openedAt: new Date(Date.now() - (svcIdx * 3600 + k * 7200) * 1000).toISOString(),
          };
          this.incidents.push(inc);
          svcIncidents.push(inc);
        }
        this.incidentsByServiceId.set(svc.id, svcIncidents);
        svcIdx++;
      }
    }
  }

  public addRecords(batch: DataRecord[]): number {
    let added = 0;
    for (const rec of batch) {
      if (!this.recordById.has(rec.id)) {
        this.records.push(rec);
        this.recordById.set(rec.id, rec);
        added++;
      }
    }
    const maxCap = 50000;
    if (this.records.length > maxCap) {
      const overflow = this.records.length - maxCap;
      const removed = this.records.splice(0, overflow);
      for (const r of removed) {
        this.recordById.delete(r.id);
      }
    }
    if (added > 0) {
      this.invalidateCache();
    }
    return added;
  }

  public prependRecord(rec: DataRecord): void {
    this.records.unshift(rec);
    this.recordById.set(rec.id, rec);
    this.invalidateCache();
  }

  public deleteRecord(id: string): boolean {
    if (!this.recordById.has(id)) return false;
    this.recordById.delete(id);
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx !== -1) {
      this.records.splice(idx, 1);
    }
    this.invalidateCache();
    return true;
  }

  public getCached<T>(key: string): T | null {
    if (this.governance.cacheTtlMs <= 0) {
      this.cacheMisses++;
      return null;
    }
    const entry = this.cache.get(key);
    if (!entry) {
      this.cacheMisses++;
      return null;
    }
    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.cacheMisses++;
      return null;
    }
    entry.lastAccessedAt = now;
    this.cacheHits++;
    return entry.value as T;
  }

  public setCached<T>(key: string, value: T): void {
    if (this.governance.cacheTtlMs <= 0) return;
    if (this.cache.size >= this.maxCacheEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache.entries()) {
        if (v.lastAccessedAt < oldestTime) {
          oldestTime = v.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    const now = Date.now();
    this.cache.set(key, {
      value,
      expiresAt: now + this.governance.cacheTtlMs,
      lastAccessedAt: now,
    });
  }

  public invalidateCache(): void {
    this.cache.clear();
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  public recordTrace(trace: ExecutionTrace): void {
    this.totalQueriesExecuted++;
    if (trace.rateLimited || trace.status === 'REJECTED') {
      this.totalRejectedRequests++;
    }
    this.totalLoaderCallsSaved += trace.loaderCallsSaved;

    this.traces.unshift(trace);
    if (this.traces.length > 80) {
      this.traces.length = 80;
    }

    this.latencySamples.push(trace.durationMs);
    if (this.latencySamples.length > 300) {
      this.latencySamples.shift();
    }

    const now = Date.now();
    this.requestTimestamps.push(now);
    const cutoff = now - 60000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
  }

  public getLatencyStats(): { p50: number; p95: number; p99: number; rpm: number } {
    const now = Date.now();
    const cutoff = now - 60000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }

    if (this.latencySamples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, rpm: this.requestTimestamps.length };
    }
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      p50: Number(pct(0.5).toFixed(2)),
      p95: Number(pct(0.95).toFixed(2)),
      p99: Number(pct(0.99).toFixed(2)),
      rpm: this.requestTimestamps.length,
    };
  }

  public filterRecords(filter?: RecordFilterInput | null): DataRecord[] {
    if (!filter) return this.records;

    const searchLower = filter.search ? filter.search.trim().toLowerCase() : '';
    const sourceSet = filter.sources && filter.sources.length > 0 ? new Set(filter.sources) : null;
    const sevSet = filter.severities && filter.severities.length > 0 ? new Set(filter.severities) : null;
    const statusSet = filter.statuses && filter.statuses.length > 0 ? new Set(filter.statuses) : null;
    const regionSet = filter.regionCodes && filter.regionCodes.length > 0 ? new Set(filter.regionCodes) : null;
    const hasAnomaly = filter.hasAnomaly;
    const minLat = filter.minLatencyMs ?? null;
    const maxLat = filter.maxLatencyMs ?? null;

    if (
      !searchLower &&
      !sourceSet &&
      !sevSet &&
      !statusSet &&
      !regionSet &&
      hasAnomaly === null &&
      hasAnomaly === undefined &&
      minLat === null &&
      maxLat === null
    ) {
      return this.records;
    }

    const result: DataRecord[] = [];
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (sourceSet && !sourceSet.has(r.source)) continue;
      if (sevSet && !sevSet.has(r.severity)) continue;
      if (statusSet && !statusSet.has(r.status)) continue;
      if (regionSet && !regionSet.has(r.regionCode)) continue;
      if (hasAnomaly !== null && hasAnomaly !== undefined && r.hasAnomaly !== hasAnomaly) continue;
      if (minLat !== null && r.metrics.latencyMs < minLat) continue;
      if (maxLat !== null && r.metrics.latencyMs > maxLat) continue;
      if (searchLower && !r._searchBlob.includes(searchLower)) continue;
      result.push(r);
    }
    return result;
  }

  public queryRecords(
    filter?: RecordFilterInput | null,
    sort?: RecordSortInput | null,
    pagination?: PaginationInput | null
  ) {
    const filtered = this.filterRecords(filter);
    const sortField = sort?.field ?? 'TIMESTAMP';
    const sortDir = sort?.direction ?? 'DESC';
    const dirMul = sortDir === 'ASC' ? 1 : -1;

    const sorted = [...filtered].sort((a, b) => {
      switch (sortField) {
        case 'TIMESTAMP':
          return (a.timestampMs - b.timestampMs) * dirMul;
        case 'LATENCY_MS':
          return (a.metrics.latencyMs - b.metrics.latencyMs) * dirMul;
        case 'AMOUNT_USD':
          return (a.metrics.amountUsd - b.metrics.amountUsd) * dirMul;
        case 'SEVERITY':
          return (SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]) * dirMul;
        case 'TITLE':
          return a.title.localeCompare(b.title, 'ru') * dirMul;
        case 'SOURCE':
          return a.source.localeCompare(b.source) * dirMul;
        default:
          return (a.timestampMs - b.timestampMs) * dirMul;
      }
    });

    const totalCount = sorted.length;

    // Support both cursor (after/first) and offset (page/pageSize)
    let pageSize = Math.min(Math.max(pagination?.first ?? pagination?.pageSize ?? 25, 1), 150);
    let startOffset = 0;
    let currentPage = Math.max(pagination?.page ?? 1, 1);

    if (pagination?.after) {
      try {
        const decoded = Buffer.from(pagination.after, 'base64').toString('utf8');
        const parsed = Number(decoded.replace('cursor:', ''));
        if (Number.isFinite(parsed) && parsed >= 0) {
          startOffset = parsed + 1;
          currentPage = Math.floor(startOffset / pageSize) + 1;
        }
      } catch {
        startOffset = 0;
      }
    } else {
      startOffset = (currentPage - 1) * pageSize;
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (startOffset >= totalCount && totalCount > 0 && !pagination?.after) {
      currentPage = totalPages;
      startOffset = (currentPage - 1) * pageSize;
    }

    const slice = sorted.slice(startOffset, startOffset + pageSize);
    const edges = slice.map((node, idx) => ({
      cursor: Buffer.from(`cursor:${startOffset + idx}`).toString('base64'),
      node,
    }));

    return {
      items: slice,
      edges,
      totalCount,
      pageInfo: {
        currentPage,
        pageSize,
        totalPages,
        hasNextPage: startOffset + slice.length < totalCount,
        hasPreviousPage: startOffset > 0,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
    };
  }

  public computeAggregations(filter: RecordFilterInput | null | undefined, groupBy: GroupByField) {
    const filtered = this.filterRecords(filter);
    const buckets = new Map<
      string,
      {
        key: string;
        count: number;
        anomalyCount: number;
        sumLatency: number;
        sumAmountUsd: number;
      }
    >();

    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      let key: string;
      switch (groupBy) {
        case 'SOURCE':
          key = r.source;
          break;
        case 'SEVERITY':
          key = r.severity;
          break;
        case 'STATUS':
          key = r.status;
          break;
        case 'REGION':
          key = r.regionCode;
          break;
        case 'CATEGORY':
          key = r.category;
          break;
      }
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, count: 0, anomalyCount: 0, sumLatency: 0, sumAmountUsd: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      if (r.hasAnomaly) bucket.anomalyCount++;
      bucket.sumLatency += r.metrics.latencyMs;
      bucket.sumAmountUsd += r.metrics.amountUsd;
    }

    const total = Math.max(1, filtered.length);
    return Array.from(buckets.values())
      .map((b) => ({
        key: b.key,
        count: b.count,
        sharePct: Number(((b.count / total) * 100).toFixed(1)),
        anomalyCount: b.anomalyCount,
        avgLatencyMs: Number((b.sumLatency / b.count).toFixed(1)),
        totalAmountUsd: Number(b.sumAmountUsd.toFixed(2)),
      }))
      .sort((a, b) => b.count - a.count);
  }
}

export const store = new DataStore();
