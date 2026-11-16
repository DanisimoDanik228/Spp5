import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import { executeGraphQL, SEVERITY_LABELS, SOURCE_LABELS } from '../lib/graphqlClient.ts';
import type {
  AggregationBucket,
  CollectorStatus,
  DataSourceType,
  FaultMode,
  GroupByField,
  SystemTelemetry,
} from '../types/graphql.ts';

interface OverviewViewProps {
  telemetry: SystemTelemetry | null;
  onRefreshTelemetry: () => Promise<void>;
  onNavigateToExplorer: (source?: DataSourceType) => void;
}

const AGGREGATION_QUERY = /* GraphQL */ `
  query OverviewAggregations($groupBy: GroupByField!) {
    aggregations(groupBy: $groupBy) {
      key
      count
      sharePct
      anomalyCount
      avgLatencyMs
      totalAmountUsd
    }
  }
`;

const TRIGGER_INGESTION_MUTATION = /* GraphQL */ `
  mutation TriggerSourceIngestion($sources: [DataSourceType!], $batchSize: Int) {
    triggerIngestion(sources: $sources, batchSize: $batchSize) {
      totalIngested
      totalStoreRecords
      results {
        source
        ingested
        retriesUsed
        durationMs
        circuitState
        error
      }
    }
  }
`;

const SET_FAULT_MODE_MUTATION = /* GraphQL */ `
  mutation SetFaultMode($source: DataSourceType!, $faultMode: FaultMode!) {
    setSourceFaultMode(source: $source, faultMode: $faultMode) {
      source
      faultMode
      circuitState
    }
  }
`;

const RESET_BREAKER_MUTATION = /* GraphQL */ `
  mutation ResetBreaker($source: DataSourceType!) {
    resetCircuitBreaker(source: $source) {
      source
      circuitState
      consecutiveFailures
    }
  }
`;

export function OverviewView({
  telemetry,
  onRefreshTelemetry,
  onNavigateToExplorer,
}: OverviewViewProps) {
  const [groupBy, setGroupBy] = useState<GroupByField>('SOURCE');
  const [buckets, setBuckets] = useState<AggregationBucket[]>([]);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  const loadAggregations = useCallback(async (targetGroup: GroupByField) => {
    setLoadingAgg(true);
    try {
      const res = await executeGraphQL<{ aggregations: AggregationBucket[] }>(
        AGGREGATION_QUERY,
        { groupBy: targetGroup },
        'OverviewAggregations'
      );
      if (res.data?.aggregations) {
        setBuckets(res.data.aggregations);
      }
    } finally {
      setLoadingAgg(false);
    }
  }, []);

  useEffect(() => {
    void loadAggregations(groupBy);
  }, [groupBy, telemetry?.totalRecords, loadAggregations]);

  const handleCollectSingle = async (source: DataSourceType) => {
    setBusySource(source);
    setBatchMessage(null);
    try {
      const res = await executeGraphQL<{
        triggerIngestion: {
          totalIngested: number;
          results: Array<{
            source: DataSourceType;
            ingested: number;
            retriesUsed: number;
            durationMs: number;
            circuitState: string;
            error: string | null;
          }>;
        };
      }>(
        TRIGGER_INGESTION_MUTATION,
        { sources: [source], batchSize: 25 },
        'TriggerSourceIngestion'
      );
      const outcome = res.data?.triggerIngestion?.results?.[0];
      if (outcome) {
        if (outcome.error) {
          setBatchMessage(
            `${SOURCE_LABELS[source]}: ${outcome.error} (повторов: ${outcome.retriesUsed}, состояние: ${outcome.circuitState})`
          );
        } else {
          setBatchMessage(
            `${SOURCE_LABELS[source]}: добавлено ${outcome.ingested} записей за ${outcome.durationMs} мс`
          );
        }
      }
      await onRefreshTelemetry();
    } finally {
      setBusySource(null);
    }
  };

  const handleFaultChange = async (source: DataSourceType, faultMode: FaultMode) => {
    setBusySource(source);
    try {
      await executeGraphQL(
        SET_FAULT_MODE_MUTATION,
        { source, faultMode },
        'SetFaultMode'
      );
      await onRefreshTelemetry();
    } finally {
      setBusySource(null);
    }
  };

  const handleResetBreaker = async (source: DataSourceType) => {
    setBusySource(source);
    try {
      await executeGraphQL(RESET_BREAKER_MUTATION, { source }, 'ResetBreaker');
      await onRefreshTelemetry();
    } finally {
      setBusySource(null);
    }
  };

  const renderCircuitLabel = (c: CollectorStatus) => {
    if (c.circuitState === 'CLOSED') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Замкнут (CLOSED)
        </span>
      );
    }
    if (c.circuitState === 'HALF_OPEN') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Пробный (HALF_OPEN)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        Разомкнут (OPEN)
      </span>
    );
  };

  const formatBucketLabel = (key: string) => {
    if (groupBy === 'SOURCE') return SOURCE_LABELS[key] ?? key;
    if (groupBy === 'SEVERITY') return SEVERITY_LABELS[key] ?? key;
    return key;
  };

  return (
    <div className="space-y-6">
      {/* KPI Summary Grid */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Объем хранилища</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {telemetry ? telemetry.totalRecords.toLocaleString('ru-RU') : '—'}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 tabular-nums">
            Аномалий: {telemetry ? telemetry.anomalyCount.toLocaleString('ru-RU') : '—'} · 4 источника
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Задержка GraphQL P95</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {telemetry ? `${telemetry.latency.p95Ms.toFixed(2)} мс` : '—'}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 tabular-nums">
            P50: {telemetry ? `${telemetry.latency.p50Ms.toFixed(2)} мс` : '—'} · {telemetry ? `${telemetry.latency.requestsPerMinute} запр/мин` : '—'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Эффективность кэша LRU</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {telemetry ? `${telemetry.cache.hitRatioPct}%` : '—'}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 tabular-nums">
            Попаданий: {telemetry ? telemetry.cache.hits : 0} · Записей: {telemetry ? telemetry.cache.entries : 0}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Оптимизация DataLoader N+1</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {telemetry ? telemetry.totalLoaderCallsSaved.toLocaleString('ru-RU') : '—'}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 tabular-nums">
            Предотвращено лишних обращений · Запросов: {telemetry ? telemetry.totalQueriesExecuted : 0}
          </div>
        </div>
      </section>

      {/* Automated Multi-Source Collectors */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Автоматизированные конвейеры сбора данных
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              4 гетерогенных формата (JSON, CSV, NDJSON, XML) с Circuit Breaker, экспоненциальным повтором и таймаутом 1200 мс
            </p>
          </div>
          {batchMessage && (
            <div className="text-xs font-medium text-slate-700 bg-slate-100 px-3 py-1.5 rounded-lg">
              {batchMessage}
            </div>
          )}
        </div>

        <div className="divide-y divide-slate-100">
          {(telemetry?.collectors ?? []).map((col) => (
            <div
              key={col.source}
              className="px-6 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 hover:bg-slate-50/60 transition-colors"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    onClick={() => onNavigateToExplorer(col.source)}
                    className="text-sm font-semibold text-slate-900 hover:text-blue-600 transition-colors text-left"
                  >
                    {col.label}
                  </button>
                  <span className="text-xs font-mono text-slate-500">{col.format}</span>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                  {renderCircuitLabel(col)}
                </div>
                <div className="text-xs text-slate-500 font-mono truncate">
                  {col.endpointLabel}
                </div>
                {col.lastError && (
                  <div className="text-xs text-red-700 font-medium">
                    Последний сбой: {col.lastError}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-6 shrink-0">
                <div className="grid grid-cols-4 gap-4 text-right tabular-nums">
                  <div>
                    <div className="text-[11px] text-slate-500">Собрано</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {col.totalCollected.toLocaleString('ru-RU')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Пакеты</div>
                    <div className="text-sm font-semibold text-slate-900">{col.totalBatches}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Повторы / Сбои</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {col.totalRetries} / {col.totalFailures}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Длит.</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {col.lastDurationMs} мс
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Режим сбоя для ${col.label}`}
                    value={col.faultMode}
                    disabled={busySource === col.source}
                    onChange={(e) =>
                      void handleFaultChange(col.source, e.target.value as FaultMode)
                    }
                    className="h-9 px-2.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="NONE">Режим: Норма</option>
                    <option value="LATENCY_SPIKE">Инъекция: Таймаут (&gt;1.2с)</option>
                    <option value="INTERMITTENT_503">Инъекция: HTTP 503</option>
                    <option value="CORRUPT_PAYLOAD">Инъекция: Битый формат</option>
                  </select>

                  <button
                    type="button"
                    disabled={busySource === col.source}
                    onClick={() => void handleCollectSingle(col.source)}
                    className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busySource === col.source ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    Собрать
                  </button>

                  {col.circuitState !== 'CLOSED' && (
                    <button
                      type="button"
                      disabled={busySource === col.source}
                      onClick={() => void handleResetBreaker(col.source)}
                      className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Сбросить
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Server-side GraphQL Aggregations */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-slate-500 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Серверная аналитическая агрегация (GraphQL aggregations)
              </h2>
              <p className="text-xs text-slate-500">
                Динамическая группировка всего массива записей на стороне Node.js без передачи сырых строк
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                ['SOURCE', 'Источники'],
                ['SEVERITY', 'Серьезность'],
                ['REGION', 'Регионы'],
                ['STATUS', 'Статусы'],
                ['CATEGORY', 'Категории'],
              ] as Array<[GroupByField, string]>
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setGroupBy(val)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  groupBy === val
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {loadingAgg && buckets.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-9 bg-slate-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 pr-4">Сегмент</th>
                    <th className="py-2.5 px-4 w-56">Доля в массиве</th>
                    <th className="py-2.5 px-4 text-right">Записей</th>
                    <th className="py-2.5 px-4 text-right">Аномалий</th>
                    <th className="py-2.5 px-4 text-right">Ср. задержка</th>
                    <th className="py-2.5 pl-4 text-right">Оборот (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {buckets.slice(0, 10).map((b) => (
                    <tr key={b.key} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2.5 pr-4 font-medium text-slate-900">
                        {formatBucketLabel(b.key)}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 rounded-full transition-all duration-300"
                              style={{ width: `${Math.min(100, Math.max(2, b.sharePct))}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-600 tabular-nums w-12 text-right">
                            {b.sharePct}%
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900">
                        {b.count.toLocaleString('ru-RU')}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-amber-700">
                        {b.anomalyCount.toLocaleString('ru-RU')}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                        {b.avgLatencyMs.toFixed(1)} мс
                      </td>
                      <td className="py-2.5 pl-4 text-right font-mono tabular-nums text-slate-700">
                        ${b.totalAmountUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
