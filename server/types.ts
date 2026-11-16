export type DataSourceType =
  | 'EDGE_LOGS'
  | 'COMMERCE_LEDGER'
  | 'IOT_TELEMETRY'
  | 'SECURITY_AUDIT';

export type RawFormatType = 'JSON' | 'CSV' | 'NDJSON' | 'XML';

export type SeverityLevel = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type RecordStatus =
  | 'ACTIVE'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'DEGRADED'
  | 'QUARANTINED';

export type FaultMode =
  | 'NONE'
  | 'LATENCY_SPIKE'
  | 'INTERMITTENT_503'
  | 'CORRUPT_PAYLOAD';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type SortField =
  | 'TIMESTAMP'
  | 'LATENCY_MS'
  | 'AMOUNT_USD'
  | 'SEVERITY'
  | 'TITLE'
  | 'SOURCE';

export type SortDirection = 'ASC' | 'DESC';

export type GroupByField =
  | 'SOURCE'
  | 'SEVERITY'
  | 'STATUS'
  | 'REGION'
  | 'CATEGORY';

export interface Region {
  id: string;
  code: string;
  name: string;
  continent: string;
  complianceTier: string;
  slaTargetPct: number;
}

export interface Cluster {
  id: string;
  name: string;
  tier: string;
  kubernetesVersion: string;
  capacityNodes: number;
  regionId: string;
}

export interface ServiceNode {
  id: string;
  name: string;
  domain: string;
  ownerTeam: string;
  version: string;
  rpsBaseline: number;
  clusterId: string;
}

export interface RelatedIncident {
  id: string;
  code: string;
  title: string;
  severity: SeverityLevel;
  impactScore: number;
  serviceId: string;
  openedAt: string;
}

export interface RecordMetrics {
  latencyMs: number;
  cpuPct: number;
  memoryMb: number;
  amountUsd: number;
  throughputRps: number;
  packetLossPct: number;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  note: string;
}

export interface DataRecord {
  id: string;
  externalId: string;
  source: DataSourceType;
  rawFormat: RawFormatType;
  rawSnippet: string;
  category: string;
  title: string;
  message: string;
  severity: SeverityLevel;
  status: RecordStatus;
  timestamp: string;
  timestampMs: number;
  serviceId: string;
  regionCode: string;
  tags: string[];
  hasAnomaly: boolean;
  metrics: RecordMetrics;
  auditTrail: AuditEvent[];
  _searchBlob: string;
}

export interface RecordFilterInput {
  search?: string | null;
  sources?: DataSourceType[] | null;
  severities?: SeverityLevel[] | null;
  statuses?: RecordStatus[] | null;
  regionCodes?: string[] | null;
  hasAnomaly?: boolean | null;
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
}

export interface RecordSortInput {
  field?: SortField | null;
  direction?: SortDirection | null;
}

export interface PaginationInput {
  page?: number | null;
  pageSize?: number | null;
  after?: string | null;
  first?: number | null;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  component: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'OK' | 'ERROR' | 'CACHED' | 'REJECTED';
  metadata: string;
}

export interface ExecutionTrace {
  traceId: string;
  operationName: string;
  operationType: string;
  timestamp: string;
  durationMs: number;
  depth: number;
  complexity: number;
  cacheHit: boolean;
  rateLimited: boolean;
  loaderBatches: number;
  loaderCallsSaved: number;
  status: 'OK' | 'REJECTED' | 'PARTIAL' | 'ERROR';
  errorCode: string | null;
  spans: TraceSpan[];
}

export interface CollectorStatus {
  source: DataSourceType;
  label: string;
  format: RawFormatType;
  endpointLabel: string;
  enabled: boolean;
  circuitState: CircuitState;
  faultMode: FaultMode;
  consecutiveFailures: number;
  totalCollected: number;
  totalBatches: number;
  totalFailures: number;
  totalRetries: number;
  lastRunAt: string | null;
  lastDurationMs: number;
  lastError: string | null;
  nextRetryAt: string | null;
}

export interface LoadControlConfig {
  maxRequestsPerMinute: number;
  burstCapacity: number;
  maxQueryDepth: number;
  maxQueryComplexity: number;
  cacheTtlMs: number;
  autoCollectorEnabled: boolean;
  autoCollectorIntervalMs: number;
}
