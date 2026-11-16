import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Globe, Layers, Server } from 'lucide-react';
import { executeGraphQL, SEVERITY_LABELS } from '../lib/graphqlClient.ts';
import type { Region } from '../types/graphql.ts';

const TOPOLOGY_QUERY = /* GraphQL */ `
  query FullInfrastructureTopology {
    regions {
      id
      code
      name
      continent
      complianceTier
      slaTargetPct
      health {
        totalRecords
        anomalyCount
        avgLatencyMs
        availabilityPct
      }
      clusters {
        id
        name
        tier
        kubernetesVersion
        capacityNodes
        services {
          id
          name
          domain
          ownerTeam
          version
          rpsBaseline
          relatedIncidents {
            id
            code
            title
            severity
            impactScore
          }
          recentRecords(limit: 4) {
            id
            externalId
            source
            title
            severity
            timestamp
            metrics {
              latencyMs
            }
          }
        }
      }
    }
  }
`;

export function TopologyView() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [traceMeta, setTraceMeta] = useState<{
    traceId: string;
    durationMs: number;
    depth: number;
    complexity: number;
    loaderCallsSaved: number;
  } | null>(null);

  const loadTopology = useCallback(async () => {
    setLoading(true);
    try {
      const res = await executeGraphQL<{ regions: Region[] }>(
        TOPOLOGY_QUERY,
        {},
        'FullInfrastructureTopology'
      );
      if (res.data?.regions) {
        setRegions(res.data.regions);
        const firstReg = res.data.regions[0];
        if (firstReg) {
          setSelectedRegionId((prev) => prev ?? firstReg.id);
          const firstCls = firstReg.clusters?.[0];
          if (firstCls) {
            setSelectedClusterId((prev) => prev ?? firstCls.id);
            const firstSvc = firstCls.services?.[0];
            if (firstSvc) {
              setSelectedServiceId((prev) => prev ?? firstSvc.id);
            }
          }
        }
      }
      if (res.extensions?.tracing) {
        setTraceMeta({
          traceId: res.extensions.tracing.traceId,
          durationMs: res.extensions.tracing.durationMs,
          depth: res.extensions.tracing.depth,
          complexity: res.extensions.tracing.complexity,
          loaderCallsSaved: res.extensions.tracing.loaderCallsSaved,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTopology();
  }, [loadTopology]);

  const activeRegion = regions.find((r) => r.id === selectedRegionId) ?? regions[0] ?? null;
  const clusters = activeRegion?.clusters ?? [];
  const activeCluster = clusters.find((c) => c.id === selectedClusterId) ?? clusters[0] ?? null;
  const services = activeCluster?.services ?? [];
  const activeService = services.find((s) => s.id === selectedServiceId) ?? services[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            5-уровневая иерархия инфраструктуры
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Один вложенный GraphQL-запрос: Регион → Кластер → Микросервис → Инциденты и События
          </p>
        </div>
        {traceMeta && (
          <div className="text-xs font-mono text-slate-600 tabular-nums">
            Trace: {traceMeta.traceId} · {traceMeta.durationMs} мс · Глубина: {traceMeta.depth} · Сложность: {traceMeta.complexity}
          </div>
        )}
      </div>

      {loading && regions.length === 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-80 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Level 1: Regions */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Globe className="w-4 h-4 text-slate-500" />
              1. Регионы ({regions.length})
            </div>
            <div className="divide-y divide-slate-100">
              {regions.map((r) => {
                const isSelected = activeRegion?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelectedRegionId(r.id);
                      const cls = r.clusters?.[0];
                      setSelectedClusterId(cls?.id ?? null);
                      setSelectedServiceId(cls?.services?.[0]?.id ?? null);
                    }}
                    className={`w-full text-left px-4 py-3 flex items-center justify-between gap-2 transition-colors ${
                      isSelected ? 'bg-blue-50/70 text-blue-900' : 'hover:bg-slate-50 text-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{r.name}</div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                        {r.code} · SLA {r.health?.availabilityPct ?? r.slaTargetPct}% · {r.health?.totalRecords ?? 0} зап.
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Level 2: Clusters */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Layers className="w-4 h-4 text-slate-500" />
              2. Кластеры ({clusters.length})
            </div>
            <div className="divide-y divide-slate-100">
              {clusters.map((c) => {
                const isSelected = activeCluster?.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelectedClusterId(c.id);
                      setSelectedServiceId(c.services?.[0]?.id ?? null);
                    }}
                    className={`w-full text-left px-4 py-3 flex items-center justify-between gap-2 transition-colors ${
                      isSelected ? 'bg-blue-50/70 text-blue-900' : 'hover:bg-slate-50 text-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold font-mono truncate">{c.name}</div>
                      <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                        {c.tier} · K8s {c.kubernetesVersion} · {c.capacityNodes} узлов
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Level 3-5: Services, Incidents, Recent Records */}
          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Server className="w-4 h-4 text-slate-500" />
              3. Сервисы, инциденты и поток записей
            </div>

            <div className="p-4 border-b border-slate-100 flex flex-wrap gap-2">
              {services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedServiceId(s.id)}
                  className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg border transition-colors whitespace-nowrap ${
                    activeService?.id === s.id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {activeService ? (
              <div className="p-5 space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  <div>
                    <div className="text-slate-500">Домен</div>
                    <div className="font-semibold text-slate-900 mt-0.5">{activeService.domain}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Команда</div>
                    <div className="font-semibold text-slate-900 mt-0.5">{activeService.ownerTeam}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Версия</div>
                    <div className="font-mono font-semibold text-slate-900 mt-0.5">{activeService.version}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Базовый RPS</div>
                    <div className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                      {activeService.rpsBaseline.toLocaleString('ru-RU')} req/s
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    4. Связанные инциденты ({activeService.relatedIncidents?.length ?? 0})
                  </h4>
                  <div className="space-y-2">
                    {(activeService.relatedIncidents ?? []).map((inc) => (
                      <div
                        key={inc.id}
                        className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-slate-50 last:border-0"
                      >
                        <div className="min-w-0">
                          <span className="font-mono font-semibold text-slate-800">{inc.code}</span>
                          <span className="text-slate-300 mx-2">·</span>
                          <span className="text-slate-700">{inc.title}</span>
                        </div>
                        <span className="font-mono tabular-nums text-slate-600 shrink-0">
                          {SEVERITY_LABELS[inc.severity] ?? inc.severity} · Влияние {inc.impactScore}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    5. Последние записи телеметрии на узле
                  </h4>
                  <div className="space-y-2">
                    {(activeService.recentRecords ?? []).map((rec) => (
                      <div
                        key={rec.id}
                        className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-slate-50 last:border-0"
                      >
                        <div className="min-w-0 truncate">
                          <span className="font-mono text-slate-500">{rec.externalId}</span>
                          <span className="text-slate-300 mx-2">·</span>
                          <span className="text-slate-800 font-medium">{rec.title}</span>
                        </div>
                        <span className="font-mono tabular-nums text-slate-600 shrink-0">
                          {rec.metrics?.latencyMs ?? 0} мс
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-slate-500">
                Выберите сервис для просмотра вложенных связей
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
