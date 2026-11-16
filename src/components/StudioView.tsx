import { useState } from 'react';
import { Play } from 'lucide-react';
import { executeGraphQL, type GraphQLResponse } from '../lib/graphqlClient.ts';

interface StudioPreset {
  id: string;
  label: string;
  query: string;
  variables: string;
}

const PRESETS: StudioPreset[] = [
  {
    id: 'deep-nested',
    label: '5 уровней вложенности + фрагмент',
    query: `fragment MetricsFields on RecordMetrics {
  latencyMs
  cpuPct
  amountUsd
  throughputRps
}

query DeepNestedExplorer($sources: [DataSourceType!], $pageSize: Int) {
  records(
    filter: { sources: $sources, hasAnomaly: true }
    sort: { field: LATENCY_MS, direction: DESC }
    pagination: { page: 1, pageSize: $pageSize }
  ) {
    totalCount
    executionMeta {
      traceId
      cacheHit
      queryDurationMs
    }
    items {
      id
      externalId
      source
      title
      severity
      metrics {
        ...MetricsFields
      }
      service {
        name
        ownerTeam
        cluster {
          name
          kubernetesVersion
          region {
            code
            name
            complianceTier
          }
        }
        relatedIncidents {
          code
          severity
          impactScore
        }
      }
    }
  }
}`,
    variables: JSON.stringify(
      { sources: ['EDGE_LOGS', 'SECURITY_AUDIT'], pageSize: 5 },
      null,
      2
    ),
  },
  {
    id: 'aggregations',
    label: 'Агрегация по регионам',
    query: `query RegionalAnalytics($groupBy: GroupByField!) {
  aggregations(groupBy: $groupBy) {
    key
    count
    sharePct
    anomalyCount
    avgLatencyMs
    totalAmountUsd
  }
}`,
    variables: JSON.stringify({ groupBy: 'REGION' }, null, 2),
  },
  {
    id: 'depth-guard',
    label: 'Тест Depth Guard (отклонение > maxDepth)',
    query: `query OverDepthAttackTest {
  regions {
    code
    clusters {
      name
      services {
        name
        recentRecords(limit: 2) {
          id
          service {
            cluster {
              region {
                name
              }
            }
          }
        }
      }
    }
  }
}`,
    variables: '{}',
  },
  {
    id: 'mutation-ingest',
    label: 'Мутация: сбор из 4 источников',
    query: `mutation CollectBatch($batchSize: Int) {
  triggerIngestion(batchSize: $batchSize) {
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
}`,
    variables: JSON.stringify({ batchSize: 10 }, null, 2),
  },
];

export function StudioView({ onDataMutated }: { onDataMutated: () => Promise<void> }) {
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0].id);
  const [queryText, setQueryText] = useState(PRESETS[0].query);
  const [variablesText, setVariablesText] = useState(PRESETS[0].variables);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GraphQLResponse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleSelectPreset = (preset: StudioPreset) => {
    setSelectedPreset(preset.id);
    setQueryText(preset.query);
    setVariablesText(preset.variables);
    setParseError(null);
  };

  const handleExecute = async () => {
    setParseError(null);
    let parsedVars: Record<string, unknown> = {};
    try {
      parsedVars = variablesText.trim() ? JSON.parse(variablesText) : {};
    } catch (err) {
      setParseError(err instanceof Error ? `Ошибка JSON переменных: ${err.message}` : 'Неверный JSON');
      return;
    }

    setRunning(true);
    try {
      const res = await executeGraphQL(queryText, parsedVars);
      setResult(res);
      if (queryText.trim().startsWith('mutation')) {
        await onDataMutated();
      }
    } finally {
      setRunning(false);
    }
  };

  const trace = result?.extensions?.tracing ?? result?.errors?.[0]?.extensions?.tracing ?? null;

  return (
    <div className="space-y-4">
      <section className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Интерактивный конструктор и консоль GraphQL
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Выполнение произвольных Query, Mutation, фрагментов и проверка ограничений глубины и сложности
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleSelectPreset(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                selectedPreset === p.id
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Editor */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700">Операция GraphQL</span>
            <button
              type="button"
              disabled={running}
              onClick={() => void handleExecute()}
              className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {running ? 'Выполнение...' : 'Выполнить запрос'}
            </button>
          </div>

          <textarea
            aria-label="GraphQL Query Editor"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            spellCheck={false}
            rows={17}
            className="w-full p-4 font-mono text-xs bg-slate-950 text-slate-100 focus:outline-none resize-y leading-relaxed"
          />

          <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
            Variables (JSON)
          </div>
          <textarea
            aria-label="GraphQL Variables Editor"
            value={variablesText}
            onChange={(e) => setVariablesText(e.target.value)}
            spellCheck={false}
            rows={5}
            className="w-full p-3 font-mono text-xs bg-slate-900 text-slate-200 focus:outline-none resize-y"
          />
          {parseError && (
            <div className="px-4 py-2 bg-red-50 text-red-700 text-xs font-medium">{parseError}</div>
          )}
        </section>

        {/* Right: Response + Execution Trace */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700">Ответ и трассировка</span>
            {result && (
              <div className="text-xs font-mono tabular-nums text-slate-600">
                HTTP {result.httpStatus} · RTT {result.clientDurationMs} мс
                {trace ? ` · Глубина ${trace.depth} · Сложность ${trace.complexity}` : ''}
              </div>
            )}
          </div>

          {trace && (
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-mono text-slate-700">
                  Trace: <span className="font-semibold text-slate-900">{trace.traceId}</span>
                </span>
                <span className="font-mono tabular-nums text-slate-600">
                  DataLoader батчей: {trace.loaderBatches} · Сэкономлено вызовов: {trace.loaderCallsSaved}
                </span>
              </div>
              <div className="space-y-1">
                {trace.spans.map((sp) => (
                  <div key={sp.spanId} className="flex items-center gap-2 text-[11px] font-mono">
                    <span className="w-44 truncate text-slate-700">{sp.name}</span>
                    <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden relative">
                      <div
                        className={`h-full rounded ${
                          sp.status === 'REJECTED' || sp.status === 'ERROR'
                            ? 'bg-red-600'
                            : sp.status === 'CACHED'
                              ? 'bg-emerald-600'
                              : 'bg-blue-600'
                        }`}
                        style={{
                          marginLeft: `${Math.min(90, (sp.startOffsetMs / Math.max(trace.durationMs, 0.2)) * 100)}%`,
                          width: `${Math.max(4, Math.min(100, (sp.durationMs / Math.max(trace.durationMs, 0.2)) * 100))}%`,
                        }}
                      />
                    </div>
                    <span className="w-16 text-right tabular-nums text-slate-600">
                      {sp.durationMs} мс
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <pre className="flex-1 p-4 font-mono text-xs bg-slate-50 text-slate-800 overflow-auto max-h-[460px] leading-relaxed">
            {result
              ? JSON.stringify(
                  {
                    ...(result.errors ? { errors: result.errors } : {}),
                    data: result.data,
                  },
                  null,
                  2
                )
              : 'Нажмите «Выполнить запрос», чтобы отправить операцию на POST /graphql и увидеть ответ с трассировкой.'}
          </pre>
        </section>
      </div>
    </div>
  );
}
