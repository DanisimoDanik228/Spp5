import type { ExecutionTrace } from '../types/graphql.ts';

export interface GraphQLErrorItem {
  message: string;
  extensions?: {
    code?: string;
    retryAfterMs?: number;
    depth?: number;
    maxQueryDepth?: number;
    complexity?: number;
    maxQueryComplexity?: number;
    tracing?: ExecutionTrace;
    [key: string]: unknown;
  };
}

export interface GraphQLResponse<TData = unknown> {
  data: TData | null;
  errors?: GraphQLErrorItem[];
  extensions?: {
    tracing?: ExecutionTrace;
    governance?: {
      availableTokens: number;
      burstCapacity: number;
      maxRequestsPerMinute: number;
      maxQueryDepth: number;
      maxQueryComplexity: number;
    };
  };
  httpStatus: number;
  clientDurationMs: number;
}

export async function executeGraphQL<
  TData = unknown,
  TVars extends Record<string, unknown> = Record<string, unknown>,
>(
  query: string,
  variables?: TVars,
  operationName?: string
): Promise<GraphQLResponse<TData>> {
  const t0 = performance.now();
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: variables ?? {},
      ...(operationName ? { operationName } : {}),
    }),
  });

  const payload = (await res.json()) as {
    data?: TData | null;
    errors?: GraphQLErrorItem[];
    extensions?: GraphQLResponse<TData>['extensions'];
  };

  return {
    data: payload.data ?? null,
    errors: payload.errors,
    extensions: payload.extensions,
    httpStatus: res.status,
    clientDurationMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export interface DynamicFieldSelection {
  includeMetrics: boolean;
  includeService: boolean;
  includeCluster: boolean;
  includeRegion: boolean;
  includeIncidents: boolean;
  includeAuditTrail: boolean;
  includeEdgesCursor: boolean;
}

export function buildDynamicRecordsQuery(sel: DynamicFieldSelection): string {
  const metricsBlock = sel.includeMetrics
    ? `
      metrics {
        latencyMs
        cpuPct
        amountUsd
        throughputRps
        packetLossPct
      }`
    : '';

  const regionBlock =
    sel.includeService && sel.includeCluster && sel.includeRegion
      ? `
          region {
            code
            name
            complianceTier
          }`
      : '';

  const clusterBlock =
    sel.includeService && sel.includeCluster
      ? `
        cluster {
          name
          tier
          kubernetesVersion${regionBlock}
        }`
      : '';

  const incidentsBlock =
    sel.includeService && sel.includeIncidents
      ? `
        relatedIncidents {
          code
          severity
          impactScore
        }`
      : '';

  const serviceBlock = sel.includeService
    ? `
      service {
        id
        name
        ownerTeam
        version${clusterBlock}${incidentsBlock}
      }`
    : '';

  const auditBlock = sel.includeAuditTrail
    ? `
      auditTrail {
        id
        timestamp
        actor
        action
      }`
    : '';

  const edgesBlock = sel.includeEdgesCursor
    ? `
    edges {
      cursor
      node {
        id
      }
    }`
    : '';

  return `query DynamicRecordsQuery(
  $filter: RecordFilterInput
  $sort: RecordSortInput
  $pagination: PaginationInput
) {
  records(filter: $filter, sort: $sort, pagination: $pagination) {
    totalCount
    pageInfo {
      currentPage
      pageSize
      totalPages
      hasNextPage
      hasPreviousPage
      endCursor
    }
    executionMeta {
      traceId
      cacheHit
      queryDurationMs
      totalStoreRecords
    }
    items {
      id
      externalId
      source
      rawFormat
      category
      title
      severity
      status
      timestamp
      regionCode
      tags
      hasAnomaly${metricsBlock}${serviceBlock}${auditBlock}
    }${edgesBlock}
  }
}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  EDGE_LOGS: 'Edge Logs (JSON)',
  COMMERCE_LEDGER: 'Commerce Ledger (CSV)',
  IOT_TELEMETRY: 'IoT Telemetry (NDJSON)',
  SECURITY_AUDIT: 'Security Audit (XML)',
};

export const SEVERITY_LABELS: Record<string, string> = {
  INFO: 'Инфо',
  LOW: 'Низкая',
  MEDIUM: 'Средняя',
  HIGH: 'Высокая',
  CRITICAL: 'Критическая',
};

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активна',
  ACKNOWLEDGED: 'Принята',
  RESOLVED: 'Решена',
  DEGRADED: 'Деградация',
  QUARANTINED: 'Карантин',
};
