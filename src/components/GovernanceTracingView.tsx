import { useEffect, useState } from 'react';
import { Activity, Eraser, Save, Zap } from 'lucide-react';
import { executeGraphQL } from '../lib/graphqlClient.ts';
import type { ExecutionTrace, LoadControlConfig, SystemTelemetry } from '../types/graphql.ts';

interface GovernanceTracingViewProps {
  telemetry: SystemTelemetry | null;
  onRefreshTelemetry: () => Promise<void>;
}

const CONFIGURE_LOAD_MUTATION = /* GraphQL */ `
  mutation ConfigureLoad($input: LoadControlInput!) {
    configureLoadControl(input: $input) {
      maxRequestsPerMinute
      burstCapacity
      maxQueryDepth
      maxQueryComplexity
      cacheTtlMs
      autoCollectorEnabled
      autoCollectorIntervalMs
    }
  }
`;

const CLEAR_CACHE_MUTATION = /* GraphQL */ `
  mutation ClearQueryCache {
    clearCache
  }
`;

const BURST_TEST_QUERY = /* GraphQL */ `
  query BurstProbe($page: Int) {
    records(pagination: { page: $page, pageSize: 10 }) {
      totalCount
      executionMeta {
        traceId
        cacheHit
        queryDurationMs
      }
      items {
        id
        title
        service {
          name
        }
      }
    }
  }
`;

export function GovernanceTracingView({
  telemetry,
  onRefreshTelemetry,
}: GovernanceTracingViewProps) {
  const [form, setForm] = useState<LoadControlConfig>({
    maxRequestsPerMinute: 120,
    burstCapacity: 30,
    maxQueryDepth: 7,
    maxQueryComplexity: 1800,
    cacheTtlMs: 12000,
    autoCollectorEnabled: true,
    autoCollectorIntervalMs: 8000,
  });

  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const [stressRunning, setStressRunning] = useState(false);
  const [stressSummary, setStressSummary] = useState<{
    total: number;
    succeeded: number;
    cacheHits: number;
    throttled: number;
    elapsedMs: number;
  } | null>(null);

  useEffect(() => {
    if (telemetry?.governance) {
      setForm(telemetry.governance);
    }
    if (telemetry?.recentTraces && telemetry.recentTraces.length > 0 && !selectedTraceId) {
      setSelectedTraceId(telemetry.recentTraces[0].traceId);
    }
  }, [telemetry, selectedTraceId]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await executeGraphQL<{ configureLoadControl: LoadControlConfig }>(
        CONFIGURE_LOAD_MUTATION,
        { input: form },
        'ConfigureLoad'
      );
      if (res.data?.configureLoadControl) {
        setSaveNote('Параметры контроля нагрузки применены');
        await onRefreshTelemetry();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClearCache = async () => {
    await executeGraphQL(CLEAR_CACHE_MUTATION, {}, 'ClearQueryCache');
    await onRefreshTelemetry();
  };

  const handleBurstStressTest = async () => {
    setStressRunning(true);
    setStressSummary(null);
    const t0 = performance.now();
    try {
      const total = 25;
      const promises = Array.from({ length: total }).map((_, idx) =>
        executeGraphQL<{
          records: { executionMeta: { cacheHit: boolean } };
        }>(BURST_TEST_QUERY, { page: (idx % 3) + 1 }, 'BurstProbe')
      );
      const outcomes = await Promise.all(promises);
      let succeeded = 0;
      let cacheHits = 0;
      let throttled = 0;
      for (const o of outcomes) {
        const isLimited = o.errors?.some((e) => e.extensions?.code === 'RATE_LIMITED');
        if (isLimited) {
          throttled++;
        } else if (o.data?.records) {
          succeeded++;
          if (o.data.records.executionMeta.cacheHit) cacheHits++;
        }
      }
      setStressSummary({
        total,
        succeeded,
        cacheHits,
        throttled,
        elapsedMs: Number((performance.now() - t0).toFixed(1)),
      });
      await onRefreshTelemetry();
    } finally {
      setStressRunning(false);
    }
  };

  const traces: ExecutionTrace[] = telemetry?.recentTraces ?? [];
  const activeTrace =
    traces.find((t) => t.traceId === selectedTraceId) ?? traces[0] ?? null;

  const tokenPct = telemetry
    ? Math.min(
        100,
        Math.round(
          (telemetry.rateLimiter.availableTokens /
            Math.max(1, telemetry.rateLimiter.burstCapacity)) *
            100
        )
      )
    : 100;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Load Control Policy Form */}
        <form
          onSubmit={handleSaveConfig}
          className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
        >
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Политики контроля нагрузки и защиты GraphQL
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Token Bucket Rate Limiter, ограничение глубины/сложности AST и управление LRU-кэшем
              </p>
            </div>
            {saveNote && (
              <span className="text-xs font-medium text-emerald-700">{saveNote}</span>
            )}
          </div>

          <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Лимит запросов в минуту (RPM)
              </label>
              <input
                type="number"
                min={5}
                max={5000}
                value={form.maxRequestsPerMinute}
                onChange={(e) =>
                  setForm((p) => ({ ...p, maxRequestsPerMinute: Number(e.target.value) }))
                }
                className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Емкость всплеска (Burst Tokens)
              </label>
              <input
                type="number"
                min={2}
                max={500}
                value={form.burstCapacity}
                onChange={(e) =>
                  setForm((p) => ({ ...p, burstCapacity: Number(e.target.value) }))
                }
                className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Макс. глубина запроса (Max Depth)
              </label>
              <input
                type="number"
                min={2}
                max={20}
                value={form.maxQueryDepth}
                onChange={(e) =>
                  setForm((p) => ({ ...p, maxQueryDepth: Number(e.target.value) }))
                }
                className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Макс. сложность (Max Complexity)
              </label>
              <input
                type="number"
                min={50}
                max={25000}
                value={form.maxQueryComplexity}
                onChange={(e) =>
                  setForm((p) => ({ ...p, maxQueryComplexity: Number(e.target.value) }))
                }
                className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                TTL LRU-кэша (мс, 0 = выкл)
              </label>
              <input
                type="number"
                min={0}
                max={120000}
                step={500}
                value={form.cacheTtlMs}
                onChange={(e) =>
                  setForm((p) => ({ ...p, cacheTtlMs: Number(e.target.value) }))
                }
                className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono tabular-nums"
              />
            </div>

            <div className="flex items-end pb-1.5">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={form.autoCollectorEnabled}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, autoCollectorEnabled: e.target.checked }))
                  }
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Автосбор данных каждые {Math.round(form.autoCollectorIntervalMs / 1000)}с
              </label>
            </div>
          </div>

          <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void handleClearCache()}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <Eraser className="w-3.5 h-3.5" />
              Очистить кэш LRU
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              Применить политики
            </button>
          </div>
        </form>

        {/* Live Token Bucket & Burst Stress Test */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Состояние ограничителя (Token Bucket)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Проверьте реакцию системы на всплеск нагрузки (снизьте Burst, например, до 10 и запустите тест)
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                <span className="text-slate-600">Доступно токенов</span>
                <span className="font-semibold text-slate-900">
                  {telemetry?.rateLimiter.availableTokens ?? 0} /{' '}
                  {telemetry?.rateLimiter.burstCapacity ?? 30}
                </span>
              </div>
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    tokenPct < 20 ? 'bg-red-600' : tokenPct < 50 ? 'bg-amber-500' : 'bg-blue-600'
                  }`}
                  style={{ width: `${tokenPct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
                <span>Пропущено: {telemetry?.rateLimiter.totalAllowed ?? 0}</span>
                <span>Отклонено (RATE_LIMITED): {telemetry?.rateLimiter.totalThrottled ?? 0}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              disabled={stressRunning}
              onClick={() => void handleBurstStressTest()}
              className="w-full h-10 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <Zap className="w-4 h-4" />
              {stressRunning
                ? 'Выполняется всплеск (25 запросов)...'
                : 'Запустить всплеск (25 параллельных запросов)'}
            </button>

            {stressSummary && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono tabular-nums space-y-1">
                <div className="font-semibold text-slate-900">
                  Итог всплеска за {stressSummary.elapsedMs} мс:
                </div>
                <div className="text-slate-700">
                  Успешно: {stressSummary.succeeded} (из кэша LRU: {stressSummary.cacheHits}) · Отклонено Rate Limiter: {stressSummary.throttled}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Distributed Tracing Inspector */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-slate-500" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Распределенная трассировка GraphQL-операций
              </h2>
              <p className="text-xs text-slate-500">
                Пошаговая детализация каждого запроса: парсинг AST, контроль глубины, кэш LRU, батчинг DataLoader
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            Отклонено политиками: {telemetry?.totalRejectedRequests ?? 0}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          {/* Trace List */}
          <div className="lg:col-span-6 overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                <tr>
                  <th className="py-2.5 px-4">Trace / Операция</th>
                  <th className="py-2.5 px-3 text-right">Глуб. / Сложн.</th>
                  <th className="py-2.5 px-3 text-right">Длит.</th>
                  <th className="py-2.5 px-4 text-right">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {traces.map((tr) => {
                  const isSel = activeTrace?.traceId === tr.traceId;
                  return (
                    <tr
                      key={tr.traceId}
                      onClick={() => setSelectedTraceId(tr.traceId)}
                      className={`cursor-pointer transition-colors ${
                        isSel ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-4">
                        <div className="font-mono font-semibold text-slate-900">
                          {tr.operationName}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {tr.traceId} · {tr.operationType}
                          {tr.cacheHit ? ' · LRU HIT' : ''}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {tr.depth} / {tr.complexity}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                        {tr.durationMs.toFixed(2)} мс
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono">
                        <span
                          className={
                            tr.status === 'OK'
                              ? 'text-emerald-700 font-medium'
                              : tr.status === 'REJECTED'
                                ? 'text-red-700 font-semibold'
                                : 'text-amber-700 font-medium'
                          }
                        >
                          {tr.errorCode ?? tr.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Span Waterfall */}
          <div className="lg:col-span-6 p-5 space-y-4">
            {activeTrace ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
                  <div>
                    <div className="text-xs font-mono text-slate-500">{activeTrace.traceId}</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {activeTrace.operationName} ({activeTrace.durationMs.toFixed(2)} мс)
                    </div>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-600">
                    DataLoader батчей: {activeTrace.loaderBatches} · Сэкономлено: {activeTrace.loaderCallsSaved}
                  </div>
                </div>

                <div className="space-y-2.5">
                  {activeTrace.spans.map((sp) => {
                    const total = Math.max(activeTrace.durationMs, 0.2);
                    const leftPct = Math.min(88, (sp.startOffsetMs / total) * 100);
                    const widthPct = Math.max(3, Math.min(100 - leftPct, (sp.durationMs / total) * 100));
                    return (
                      <div key={sp.spanId} className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="font-medium text-slate-800">
                            {sp.name}{' '}
                            <span className="text-slate-400 font-normal">({sp.component})</span>
                          </span>
                          <span className="tabular-nums text-slate-700">{sp.durationMs} мс</span>
                        </div>
                        <div className="h-2.5 bg-slate-100 rounded overflow-hidden relative">
                          <div
                            className={`h-full rounded ${
                              sp.status === 'REJECTED' || sp.status === 'ERROR'
                                ? 'bg-red-600'
                                : sp.status === 'CACHED'
                                  ? 'bg-emerald-600'
                                  : 'bg-blue-600'
                            }`}
                            style={{ marginLeft: `${leftPct}%`, width: `${widthPct}%` }}
                          />
                        </div>
                        {sp.metadata && (
                          <div className="text-[11px] font-mono text-slate-500 truncate">
                            {sp.metadata}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="py-12 text-center text-xs text-slate-500">
                Выберите трассу слева для просмотра дерева спанов
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
