import { store } from './store.ts';
import type {
  CollectorStatus,
  DataRecord,
  DataSourceType,
  FaultMode,
  RawFormatType,
  RecordStatus,
  SeverityLevel,
} from './types.ts';

interface SourceRuntime {
  status: CollectorStatus;
  openUntilMs: number;
  seqCounter: number;
}

const SOURCE_META: Record<
  DataSourceType,
  { label: string; format: RawFormatType; endpointLabel: string }
> = {
  EDGE_LOGS: {
    label: 'Edge Gateway Logs',
    format: 'JSON',
    endpointLabel: 'stream://edge-ingress.internal/v2/logs.json',
  },
  COMMERCE_LEDGER: {
    label: 'Commerce & Billing Feed',
    format: 'CSV',
    endpointLabel: 'batch://ledger-eu.internal/exports/tx.csv',
  },
  IOT_TELEMETRY: {
    label: 'IoT Infrastructure Sensors',
    format: 'NDJSON',
    endpointLabel: 'socket://rack-telemetry.internal/frames.ndjson',
  },
  SECURITY_AUDIT: {
    label: 'Security & WAF Audit',
    format: 'XML',
    endpointLabel: 'webhook://secops-siem.internal/audit.xml',
  },
};

const CATEGORIES: Record<DataSourceType, string[]> = {
  EDGE_LOGS: ['HTTP_INGRESS', 'GRPC_STREAM', 'RATE_SHAPING', 'TLS_HANDSHAKE'],
  COMMERCE_LEDGER: ['PAYMENT_CAPTURE', 'SETTLEMENT_BATCH', 'REFUND_CLAIM', 'FX_CLEARING'],
  IOT_TELEMETRY: ['THERMAL_PROBE', 'POWER_PDU', 'NVME_SMART', 'NIC_DROP_MONITOR'],
  SECURITY_AUDIT: ['WAF_RULE_MATCH', 'JWT_VALIDATION', 'RBAC_ESCALATION', 'CVE_SIGNATURE'],
};

const EDGE_TITLES = [
  'Превышение времени ответа upstream-шлюза',
  'Нормализованный поток GraphQL-маршрутизации',
  'Сброс TLS-сессии на пограничном балансировщике',
  'Пиковая пропускная способность gRPC-канала',
  'Ошибка кэширования на CDN-узле маршрута',
];

const COMMERCE_TITLES = [
  'Авторизация транзакции по мультивалютному шлюзу',
  'Расчетная ведомость клиринга корпоративного пула',
  'Возврат платежа по правилу антифрод-фильтра',
  'Задержка подтверждения межбанковского токена',
  'Пакетная сверка биллинговых ордеров',
];

const IOT_TITLES = [
  'Телеметрия стойки: температура ядра в пределах нормы',
  'Аномалия потребления тока на шине питания PDU-B',
  'Деградация пропускной способности сетевого адаптера',
  'Контроль износа NVMe-накопителя в узле хранения',
  'Потеря пакетов в межузловом телеметрическом кольце',
];

const SEC_TITLES = [
  'Срабатывание правила WAF против инъекции запроса',
  'Истечение короткоживущего токена сервисного аккаунта',
  'Попытка обхода политики доступа RBAC на шлюзе',
  'Успешная ротация корневого сертификата mTLS',
  'Обнаружена подозрительная серия запросов с подсети',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick<T>(arr: T[], idx: number): T {
  return arr[Math.abs(idx) % arr.length];
}

export class IngestionManager {
  private readonly runtimes = new Map<DataSourceType, SourceRuntime>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isTicking = false;

  constructor() {
    const sources: DataSourceType[] = [
      'EDGE_LOGS',
      'COMMERCE_LEDGER',
      'IOT_TELEMETRY',
      'SECURITY_AUDIT',
    ];
    for (const source of sources) {
      const meta = SOURCE_META[source];
      this.runtimes.set(source, {
        status: {
          source,
          label: meta.label,
          format: meta.format,
          endpointLabel: meta.endpointLabel,
          enabled: true,
          circuitState: 'CLOSED',
          faultMode: 'NONE',
          consecutiveFailures: 0,
          totalCollected: 0,
          totalBatches: 0,
          totalFailures: 0,
          totalRetries: 0,
          lastRunAt: null,
          lastDurationMs: 0,
          lastError: null,
          nextRetryAt: null,
        },
        openUntilMs: 0,
        seqCounter: 1,
      });
    }
  }

  public seedInitialVolume(recordsPerSource = 3100): number {
    const startMs = performance.now();
    const sources: DataSourceType[] = [
      'EDGE_LOGS',
      'COMMERCE_LEDGER',
      'IOT_TELEMETRY',
      'SECURITY_AUDIT',
    ];
    let totalAdded = 0;

    for (const source of sources) {
      const rt = this.runtimes.get(source)!;
      const batch: DataRecord[] = [];
      const now = Date.now();

      for (let i = 0; i < recordsPerSource; i++) {
        const seq = rt.seqCounter++;
        const ageMs = ((i * 193) % (21 * 24 * 3600)) * 1000;
        const tsMs = now - ageMs;
        batch.push(this.buildNormalizedRecord(source, seq, tsMs, true));
      }

      const added = store.addRecords(batch);
      totalAdded += added;
      rt.status.totalCollected += added;
      rt.status.totalBatches += 1;
      rt.status.lastRunAt = new Date().toISOString();
      rt.status.lastDurationMs = Number(((performance.now() - startMs) / 4).toFixed(2));
    }

    // Sort newest first initially for fast default descending traversal
    store.records.sort((a, b) => b.timestampMs - a.timestampMs);
    return totalAdded;
  }

  public startScheduler(): void {
    this.stopScheduler();
    const interval = Math.max(3000, store.governance.autoCollectorIntervalMs);
    this.timer = setInterval(() => {
      if (!store.governance.autoCollectorEnabled || this.isTicking) return;
      this.isTicking = true;
      void this.collectFromSources(
        ['EDGE_LOGS', 'COMMERCE_LEDGER', 'IOT_TELEMETRY', 'SECURITY_AUDIT'],
        4
      ).finally(() => {
        this.isTicking = false;
      });
    }, interval);
  }

  public stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getStatuses(): CollectorStatus[] {
    const now = Date.now();
    const result: CollectorStatus[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.status.circuitState === 'OPEN' && now >= rt.openUntilMs) {
        rt.status.circuitState = 'HALF_OPEN';
        rt.status.nextRetryAt = null;
      }
      result.push({ ...rt.status });
    }
    return result;
  }

  public setFaultMode(source: DataSourceType, faultMode: FaultMode): CollectorStatus {
    const rt = this.runtimes.get(source);
    if (!rt) throw new Error(`Unknown source ${source}`);
    rt.status.faultMode = faultMode;
    return { ...rt.status };
  }

  public resetCircuitBreaker(source: DataSourceType): CollectorStatus {
    const rt = this.runtimes.get(source);
    if (!rt) throw new Error(`Unknown source ${source}`);
    rt.status.circuitState = 'CLOSED';
    rt.status.consecutiveFailures = 0;
    rt.status.lastError = null;
    rt.status.nextRetryAt = null;
    rt.openUntilMs = 0;
    return { ...rt.status };
  }

  public async collectFromSources(
    sources: DataSourceType[],
    batchSize = 12
  ): Promise<{
    totalIngested: number;
    results: Array<{
      source: DataSourceType;
      ingested: number;
      retriesUsed: number;
      durationMs: number;
      circuitState: string;
      error: string | null;
    }>;
  }> {
    const safeBatch = Math.min(Math.max(batchSize, 1), 250);
    const promises = sources.map((source) => this.collectSingleSource(source, safeBatch));
    const results = await Promise.all(promises);
    const totalIngested = results.reduce((acc, r) => acc + r.ingested, 0);
    return { totalIngested, results };
  }

  private async collectSingleSource(source: DataSourceType, batchSize: number) {
    const rt = this.runtimes.get(source)!;
    const t0 = performance.now();
    const now = Date.now();

    if (rt.status.circuitState === 'OPEN') {
      if (now < rt.openUntilMs) {
        return {
          source,
          ingested: 0,
          retriesUsed: 0,
          durationMs: 0,
          circuitState: rt.status.circuitState,
          error: `Circuit Breaker OPEN (повторная проба после ${new Date(rt.openUntilMs).toLocaleTimeString('ru-RU')})`,
        };
      }
      rt.status.circuitState = 'HALF_OPEN';
    }

    const maxRetries = 2;
    let retriesUsed = 0;
    let lastErr: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const records = await this.withTimeout(
          this.fetchAndParseSource(source, batchSize, rt),
          1200
        );
        const added = store.addRecords(records);
        rt.status.totalCollected += added;
        rt.status.totalBatches += 1;
        rt.status.consecutiveFailures = 0;
        rt.status.circuitState = 'CLOSED';
        rt.status.lastError = null;
        rt.status.nextRetryAt = null;
        rt.status.lastRunAt = new Date().toISOString();
        const dur = Number((performance.now() - t0).toFixed(2));
        rt.status.lastDurationMs = dur;

        return {
          source,
          ingested: added,
          retriesUsed,
          durationMs: dur,
          circuitState: rt.status.circuitState,
          error: null,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err.message : 'Unknown ingestion failure';
        if (attempt < maxRetries) {
          retriesUsed++;
          rt.status.totalRetries++;
          const backoffMs = 55 * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
          await sleep(backoffMs);
        }
      }
    }

    // All attempts failed -> record failure & possibly trip Circuit Breaker
    rt.status.totalFailures += 1;
    rt.status.consecutiveFailures += 1;
    rt.status.lastError = lastErr;
    rt.status.lastRunAt = new Date().toISOString();
    rt.status.lastDurationMs = Number((performance.now() - t0).toFixed(2));

    if (rt.status.consecutiveFailures >= 3 || rt.status.circuitState === 'HALF_OPEN') {
      rt.status.circuitState = 'OPEN';
      rt.openUntilMs = Date.now() + 15000;
      rt.status.nextRetryAt = new Date(rt.openUntilMs).toISOString();
    }

    return {
      source,
      ingested: 0,
      retriesUsed,
      durationMs: rt.status.lastDurationMs,
      circuitState: rt.status.circuitState,
      error: lastErr,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Source timeout exceeded (${timeoutMs}ms)`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchAndParseSource(
    source: DataSourceType,
    batchSize: number,
    rt: SourceRuntime
  ): Promise<DataRecord[]> {
    const fault = rt.status.faultMode;

    if (fault === 'LATENCY_SPIKE') {
      await sleep(1450); // Triggers 1200ms timeout guard
    } else if (fault === 'INTERMITTENT_503') {
      if (Math.random() < 0.88) {
        throw new Error(`HTTP 503 Service Unavailable от ${SOURCE_META[source].endpointLabel}`);
      }
    } else {
      await sleep(6 + Math.floor(Math.random() * 14));
    }

    const now = Date.now();
    // Generate realistic raw wire format & parse it back to demonstrate heterogeneous ingestion
    switch (source) {
      case 'EDGE_LOGS': {
        if (fault === 'CORRUPT_PAYLOAD') {
          JSON.parse('{"events": [{"id": "broken-json", ');
        }
        const rawEvents = [];
        for (let i = 0; i < batchSize; i++) {
          const seq = rt.seqCounter++;
          rawEvents.push(this.buildNormalizedRecord(source, seq, now - i * 250, false));
        }
        // Round-trip real JSON wire serialization & parsing
        const jsonPayload = JSON.stringify(
          rawEvents.map((e) => ({
            extId: e.externalId,
            cat: e.category,
            ttl: e.title,
            msg: e.message,
            sev: e.severity,
            st: e.status,
            ts: e.timestamp,
            svcId: e.serviceId,
            lat: e.metrics.latencyMs,
            rps: e.metrics.throughputRps,
          }))
        );
        const parsed = JSON.parse(jsonPayload) as Array<{ extId: string }>;
        if (!Array.isArray(parsed) || parsed.length !== rawEvents.length) {
          throw new Error('JSON schema mismatch');
        }
        return rawEvents;
      }

      case 'COMMERCE_LEDGER': {
        if (fault === 'CORRUPT_PAYLOAD') {
          throw new Error('CSV Parser Error: mismatched column count (expected 8, got 3)');
        }
        const rows: DataRecord[] = [];
        const csvLines = ['externalId,category,severity,status,amountUsd,latencyMs,serviceId'];
        for (let i = 0; i < batchSize; i++) {
          const seq = rt.seqCounter++;
          const rec = this.buildNormalizedRecord(source, seq, now - i * 310, false);
          rows.push(rec);
          csvLines.push(
            `${rec.externalId},${rec.category},${rec.severity},${rec.status},${rec.metrics.amountUsd},${rec.metrics.latencyMs},${rec.serviceId}`
          );
        }
        // Parse CSV back to validate schema
        const parsedLines = csvLines.slice(1).map((line) => line.split(','));
        if (parsedLines.some((cols) => cols.length !== 7)) {
          throw new Error('Malformed CSV ledger row');
        }
        return rows;
      }

      case 'IOT_TELEMETRY': {
        if (fault === 'CORRUPT_PAYLOAD') {
          const badLine = '{"frame":1,"cpu":NaN';
          JSON.parse(badLine);
        }
        const rows: DataRecord[] = [];
        const ndjsonLines: string[] = [];
        for (let i = 0; i < batchSize; i++) {
          const seq = rt.seqCounter++;
          const rec = this.buildNormalizedRecord(source, seq, now - i * 190, false);
          rows.push(rec);
          ndjsonLines.push(
            JSON.stringify({
              id: rec.externalId,
              cpu: rec.metrics.cpuPct,
              mem: rec.metrics.memoryMb,
              loss: rec.metrics.packetLossPct,
              ts: rec.timestamp,
            })
          );
        }
        for (const line of ndjsonLines) {
          JSON.parse(line);
        }
        return rows;
      }

      case 'SECURITY_AUDIT': {
        if (fault === 'CORRUPT_PAYLOAD') {
          throw new Error('XML Parse Error: unclosed <AuditEvent> element at line 4');
        }
        const rows: DataRecord[] = [];
        const xmlParts = ['<AuditBatch>'];
        for (let i = 0; i < batchSize; i++) {
          const seq = rt.seqCounter++;
          const rec = this.buildNormalizedRecord(source, seq, now - i * 420, false);
          rows.push(rec);
          xmlParts.push(
            `<Event id="${rec.externalId}" severity="${rec.severity}" status="${rec.status}" service="${rec.serviceId}" />`
          );
        }
        xmlParts.push('</AuditBatch>');
        const xmlPayload = xmlParts.join('');
        const matches = xmlPayload.match(/<Event\s+[^>]*\/>/g);
        if (!matches || matches.length !== batchSize) {
          throw new Error('XML integrity verification failed');
        }
        return rows;
      }
    }
  }

  private buildNormalizedRecord(
    source: DataSourceType,
    seq: number,
    tsMs: number,
    isSeed: boolean
  ): DataRecord {
    const svc = pick(store.services, seq * 7 + source.length);
    const cluster = store.clusterById.get(svc.clusterId)!;
    const region = store.regionById.get(cluster.regionId)!;

    const cats = CATEGORIES[source];
    const category = pick(cats, seq * 3);

    const sevPool: SeverityLevel[] = [
      'INFO',
      'INFO',
      'LOW',
      'LOW',
      'MEDIUM',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ];
    const severity = pick(sevPool, seq * 11 + (isSeed ? 0 : 2));

    const statusPool: RecordStatus[] = [
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
      'ACKNOWLEDGED',
      'RESOLVED',
      'DEGRADED',
      'QUARANTINED',
    ];
    const status =
      severity === 'CRITICAL' && seq % 3 === 0
        ? 'QUARANTINED'
        : severity === 'HIGH' && seq % 2 === 0
          ? 'DEGRADED'
          : pick(statusPool, seq * 5);

    const hasAnomaly =
      severity === 'CRITICAL' || severity === 'HIGH' || status === 'DEGRADED' || seq % 11 === 0;

    const latencyBase =
      source === 'EDGE_LOGS'
        ? 18
        : source === 'COMMERCE_LEDGER'
          ? 64
          : source === 'IOT_TELEMETRY'
            ? 12
            : 31;
    const latencyMs = Number(
      (latencyBase + ((seq * 37) % 190) + (hasAnomaly ? 180 + (seq % 240) : 0)).toFixed(1)
    );
    const cpuPct = Number((18 + ((seq * 19) % 58) + (hasAnomaly ? 19 : 0)).toFixed(1));
    const memoryMb = 256 + ((seq * 73) % 3400);
    const amountUsd =
      source === 'COMMERCE_LEDGER'
        ? Number((24.5 + ((seq * 89.37) % 14500)).toFixed(2))
        : Number((((seq * 13.4) % 420) + 1.2).toFixed(2));
    const throughputRps = Math.round(svc.rpsBaseline * (0.65 + ((seq % 70) / 100)));
    const packetLossPct = hasAnomaly ? Number((0.4 + ((seq % 25) * 0.12)).toFixed(2)) : Number(((seq % 5) * 0.02).toFixed(2));

    const prefix =
      source === 'EDGE_LOGS'
        ? 'EDG'
        : source === 'COMMERCE_LEDGER'
          ? 'COM'
          : source === 'IOT_TELEMETRY'
            ? 'IOT'
            : 'SEC';

    const id = `${prefix.toLowerCase()}-${seq}`;
    const externalId = `${prefix}-${String(seq).padStart(6, '0')}`;
    const timestamp = new Date(tsMs).toISOString();

    const title =
      source === 'EDGE_LOGS'
        ? pick(EDGE_TITLES, seq)
        : source === 'COMMERCE_LEDGER'
          ? pick(COMMERCE_TITLES, seq)
          : source === 'IOT_TELEMETRY'
            ? pick(IOT_TITLES, seq)
            : pick(SEC_TITLES, seq);

    const message = `${title} · узел ${svc.name} (${region.code}) · задержка ${latencyMs} мс`;

    const tags = [
      region.code,
      cluster.tier,
      category.toLowerCase(),
      hasAnomaly ? 'anomaly' : 'nominal',
    ];

    const rawFormat = SOURCE_META[source].format;
    let rawSnippet = '';
    if (rawFormat === 'JSON') {
      rawSnippet = JSON.stringify(
        { id: externalId, service: svc.name, region: region.code, latencyMs, status },
        null,
        2
      );
    } else if (rawFormat === 'CSV') {
      rawSnippet = `id,category,region,amount_usd,latency_ms,status\n${externalId},${category},${region.code},${amountUsd},${latencyMs},${status}`;
    } else if (rawFormat === 'NDJSON') {
      rawSnippet = `{"sensor":"${externalId}","cluster":"${cluster.name}","cpu":${cpuPct},"memMb":${memoryMb},"lossPct":${packetLossPct}}`;
    } else {
      rawSnippet = `<AuditEvent id="${externalId}" severity="${severity}" region="${region.code}">\n  <Service>${svc.name}</Service>\n  <Policy>${category}</Policy>\n</AuditEvent>`;
    }

    const auditTrail = [
      {
        id: `aud-${id}-1`,
        timestamp,
        actor: `collector:${source.toLowerCase()}`,
        action: 'INGESTED',
        note: `Нормализовано из формата ${rawFormat}`,
      },
    ];
    if (status !== 'ACTIVE') {
      auditTrail.push({
        id: `aud-${id}-2`,
        timestamp: new Date(tsMs + 15000).toISOString(),
        actor: 'policy-engine@graphpulse',
        action: `TRANSITION_${status}`,
        note: hasAnomaly ? 'Автоматическая маркировка по порогу SLA' : 'Плановая проверка',
      });
    }

    const _searchBlob = `${id} ${externalId} ${title} ${category} ${source} ${severity} ${status} ${region.code} ${region.name} ${cluster.name} ${svc.name} ${svc.ownerTeam} ${tags.join(' ')}`.toLowerCase();

    return {
      id,
      externalId,
      source,
      rawFormat,
      rawSnippet,
      category,
      title,
      message,
      severity,
      status,
      timestamp,
      timestampMs: tsMs,
      serviceId: svc.id,
      regionCode: region.code,
      tags,
      hasAnomaly,
      metrics: {
        latencyMs,
        cpuPct,
        memoryMb,
        amountUsd,
        throughputRps,
        packetLossPct,
      },
      auditTrail,
      _searchBlob,
    };
  }
}

export const ingestionManager = new IngestionManager();
