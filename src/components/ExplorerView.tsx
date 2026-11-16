import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Code2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildDynamicRecordsQuery,
  type DynamicFieldSelection,
  executeGraphQL,
  SEVERITY_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
} from '../lib/graphqlClient.ts';
import type {
  DataRecord,
  DataSourceType,
  ExecutionTrace,
  RecordConnection,
  RecordStatus,
  SeverityLevel,
  SortDirection,
  SortField,
} from '../types/graphql.ts';

interface ExplorerViewProps {
  initialSourceFilter?: DataSourceType | null;
  onClearInitialSource?: () => void;
  onDataMutated: () => Promise<void>;
}

const DEEP_RECORD_QUERY = /* GraphQL */ `
  query RecordDeepInspect($id: ID!) {
    record(id: $id) {
      id
      externalId
      source
      rawFormat
      rawSnippet
      category
      title
      message
      severity
      status
      timestamp
      regionCode
      tags
      hasAnomaly
      metrics {
        latencyMs
        cpuPct
        memoryMb
        amountUsd
        throughputRps
        packetLossPct
      }
      service {
        id
        name
        domain
        ownerTeam
        version
        rpsBaseline
        cluster {
          id
          name
          tier
          kubernetesVersion
          capacityNodes
          region {
            id
            code
            name
            continent
            complianceTier
            slaTargetPct
          }
        }
        relatedIncidents {
          id
          code
          title
          severity
          impactScore
        }
      }
      auditTrail {
        id
        timestamp
        actor
        action
        note
      }
    }
  }
`;

const UPDATE_STATUS_MUTATION = /* GraphQL */ `
  mutation UpdateStatus($id: ID!, $status: RecordStatus!, $note: String) {
    updateRecordStatus(id: $id, status: $status, note: $note) {
      id
      status
      auditTrail {
        id
        timestamp
        actor
        action
        note
      }
    }
  }
`;

const DELETE_RECORD_MUTATION = /* GraphQL */ `
  mutation DeleteRecord($id: ID!) {
    deleteRecord(id: $id)
  }
`;

const CREATE_RECORD_MUTATION = /* GraphQL */ `
  mutation CreateManualRecord($input: CreateRecordInput!) {
    createRecord(input: $input) {
      id
      externalId
      title
      source
      severity
      status
    }
  }
`;

const SERVICES_LIST_QUERY = /* GraphQL */ `
  query ListServicesForCreate {
    services {
      id
      name
      domain
    }
  }
`;

export function ExplorerView({
  initialSourceFilter,
  onClearInitialSource,
  onDataMutated,
}: ExplorerViewProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedSources, setSelectedSources] = useState<DataSourceType[]>(
    initialSourceFilter ? [initialSourceFilter] : []
  );
  const [severityFilter, setSeverityFilter] = useState<SeverityLevel | ''>('');
  const [statusFilter, setStatusFilter] = useState<RecordStatus | ''>('');
  const [regionFilter, setRegionFilter] = useState('');
  const [anomalyOnly, setAnomalyOnly] = useState(false);

  const [sortField, setSortField] = useState<SortField>('TIMESTAMP');
  const [sortDir, setSortDir] = useState<SortDirection>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [fieldSelection, setFieldSelection] = useState<DynamicFieldSelection>({
    includeMetrics: true,
    includeService: true,
    includeCluster: true,
    includeRegion: false,
    includeIncidents: false,
    includeAuditTrail: false,
    includeEdgesCursor: true,
  });

  const [showQueryDrawer, setShowQueryDrawer] = useState(false);
  const [connection, setConnection] = useState<RecordConnection | null>(null);
  const [lastTrace, setLastTrace] = useState<ExecutionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Record Inspection Drawer
  const [inspectedRecord, setInspectedRecord] = useState<DataRecord | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [statusNote, setStatusNote] = useState('');

  // Create Record Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [availableServices, setAvailableServices] = useState<Array<{ id: string; name: string }>>([]);
  const [createForm, setCreateForm] = useState({
    source: 'EDGE_LOGS' as DataSourceType,
    category: 'HTTP_INGRESS',
    title: '',
    message: '',
    severity: 'MEDIUM' as SeverityLevel,
    serviceId: 'svc-1',
    latencyMs: 65,
    amountUsd: 120,
  });

  useEffect(() => {
    if (initialSourceFilter) {
      setSelectedSources([initialSourceFilter]);
      setPage(1);
      onClearInitialSource?.();
    }
  }, [initialSourceFilter, onClearInitialSource]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 220);
    return () => clearTimeout(t);
  }, [search]);

  const dynamicQuery = useMemo(
    () => buildDynamicRecordsQuery(fieldSelection),
    [fieldSelection]
  );

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const filter: Record<string, unknown> = {};
      if (debouncedSearch.trim()) filter.search = debouncedSearch.trim();
      if (selectedSources.length > 0) filter.sources = selectedSources;
      if (severityFilter) filter.severities = [severityFilter];
      if (statusFilter) filter.statuses = [statusFilter];
      if (regionFilter) filter.regionCodes = [regionFilter];
      if (anomalyOnly) filter.hasAnomaly = true;

      const res = await executeGraphQL<{ records: RecordConnection }>(
        dynamicQuery,
        {
          filter,
          sort: { field: sortField, direction: sortDir },
          pagination: { page, pageSize },
        },
        'DynamicRecordsQuery'
      );

      if (res.errors && res.errors.length > 0) {
        setErrorMsg(res.errors[0].message);
      }
      if (res.data?.records) {
        setConnection(res.data.records);
      }
      if (res.extensions?.tracing) {
        setLastTrace(res.extensions.tracing);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка выполнения GraphQL-запроса');
    } finally {
      setLoading(false);
    }
  }, [
    dynamicQuery,
    debouncedSearch,
    selectedSources,
    severityFilter,
    statusFilter,
    regionFilter,
    anomalyOnly,
    sortField,
    sortDir,
    page,
    pageSize,
  ]);

  useEffect(() => {
    void fetchRecords();
  }, [fetchRecords]);

  const openInspect = async (id: string) => {
    setInspectLoading(true);
    try {
      const res = await executeGraphQL<{ record: DataRecord }>(
        DEEP_RECORD_QUERY,
        { id },
        'RecordDeepInspect'
      );
      if (res.data?.record) {
        setInspectedRecord(res.data.record);
      }
    } finally {
      setInspectLoading(false);
    }
  };

  const handleStatusUpdate = async (id: string, nextStatus: RecordStatus) => {
    setInspectLoading(true);
    try {
      const res = await executeGraphQL<{ updateRecordStatus: DataRecord }>(
        UPDATE_STATUS_MUTATION,
        {
          id,
          status: nextStatus,
          note: statusNote.trim() || `Обновлено оператором в Обозревателе`,
        },
        'UpdateStatus'
      );
      if (res.data?.updateRecordStatus) {
        setStatusNote('');
        await openInspect(id);
        await fetchRecords();
        await onDataMutated();
      }
    } finally {
      setInspectLoading(false);
    }
  };

  const handleDeleteRecord = async (id: string) => {
    setInspectLoading(true);
    try {
      const res = await executeGraphQL<{ deleteRecord: boolean }>(
        DELETE_RECORD_MUTATION,
        { id },
        'DeleteRecord'
      );
      if (res.data?.deleteRecord) {
        setInspectedRecord(null);
        await fetchRecords();
        await onDataMutated();
      }
    } finally {
      setInspectLoading(false);
    }
  };

  const openCreateModal = async () => {
    setShowCreateModal(true);
    if (availableServices.length === 0) {
      const res = await executeGraphQL<{ services: Array<{ id: string; name: string }> }>(
        SERVICES_LIST_QUERY,
        {},
        'ListServicesForCreate'
      );
      if (res.data?.services) {
        setAvailableServices(res.data.services);
      }
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.title.trim()) return;
    const res = await executeGraphQL(
      CREATE_RECORD_MUTATION,
      {
        input: {
          source: createForm.source,
          category: createForm.category,
          title: createForm.title.trim(),
          message: createForm.message.trim() || createForm.title.trim(),
          severity: createForm.severity,
          serviceId: createForm.serviceId,
          latencyMs: Number(createForm.latencyMs),
          amountUsd: Number(createForm.amountUsd),
          tags: ['manual', 'graphql-mutation'],
        },
      },
      'CreateManualRecord'
    );
    if (!res.errors) {
      setShowCreateModal(false);
      setCreateForm((prev) => ({ ...prev, title: '', message: '' }));
      setPage(1);
      await fetchRecords();
      await onDataMutated();
    }
  };

  const toggleSource = (src: DataSourceType) => {
    setPage(1);
    setSelectedSources((prev) =>
      prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src]
    );
  };

  const severityColor = (sev: SeverityLevel) => {
    if (sev === 'CRITICAL') return 'text-red-700 font-semibold';
    if (sev === 'HIGH') return 'text-amber-700 font-semibold';
    if (sev === 'MEDIUM') return 'text-slate-800 font-medium';
    return 'text-slate-500';
  };

  const statusColor = (st: RecordStatus) => {
    if (st === 'ACTIVE') return 'text-emerald-700';
    if (st === 'DEGRADED') return 'text-amber-700';
    if (st === 'QUARANTINED') return 'text-red-700';
    return 'text-slate-600';
  };

  return (
    <div className="space-y-4">
      {/* Filter & Search Toolbar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по ID, заголовку, сервису, региону, тегам..."
              className="w-full h-9 pl-9 pr-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Фильтр по серьезности"
              value={severityFilter}
              onChange={(e) => {
                setSeverityFilter(e.target.value as SeverityLevel | '');
                setPage(1);
              }}
              className="h-9 px-2.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="">Все уровни</option>
              <option value="CRITICAL">Критическая</option>
              <option value="HIGH">Высокая</option>
              <option value="MEDIUM">Средняя</option>
              <option value="LOW">Низкая</option>
              <option value="INFO">Инфо</option>
            </select>

            <select
              aria-label="Фильтр по статусу"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as RecordStatus | '');
                setPage(1);
              }}
              className="h-9 px-2.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="">Все статусы</option>
              <option value="ACTIVE">Активна</option>
              <option value="ACKNOWLEDGED">Принята</option>
              <option value="RESOLVED">Решена</option>
              <option value="DEGRADED">Деградация</option>
              <option value="QUARANTINED">Карантин</option>
            </select>

            <select
              aria-label="Фильтр по региону"
              value={regionFilter}
              onChange={(e) => {
                setRegionFilter(e.target.value);
                setPage(1);
              }}
              className="h-9 px-2.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="">Все регионы</option>
              <option value="eu-central-1">eu-central-1</option>
              <option value="eu-north-1">eu-north-1</option>
              <option value="us-east-1">us-east-1</option>
              <option value="us-west-2">us-west-2</option>
              <option value="ap-northeast-1">ap-northeast-1</option>
              <option value="sa-east-1">sa-east-1</option>
            </select>

            <button
              type="button"
              onClick={() => {
                setAnomalyOnly((v) => !v);
                setPage(1);
              }}
              className={`h-9 px-3 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                anomalyOnly
                  ? 'bg-amber-50 border-amber-300 text-amber-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              Только аномалии
            </button>

            <button
              type="button"
              onClick={() => void openCreateModal()}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Создать запись
            </button>
          </div>
        </div>

        {/* Source Segmented Filter + Sort */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                'EDGE_LOGS',
                'COMMERCE_LEDGER',
                'IOT_TELEMETRY',
                'SECURITY_AUDIT',
              ] as DataSourceType[]
            ).map((src) => {
              const active = selectedSources.includes(src);
              return (
                <button
                  key={src}
                  type="button"
                  onClick={() => toggleSource(src)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:text-slate-900'
                  }`}
                >
                  {SOURCE_LABELS[src]}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ArrowDownUp className="w-3.5 h-3.5 text-slate-400" />
            <select
              aria-label="Поле сортировки"
              value={sortField}
              onChange={(e) => {
                setSortField(e.target.value as SortField);
                setPage(1);
              }}
              className="h-8 px-2 text-xs font-medium bg-white border border-slate-200 rounded-md text-slate-700"
            >
              <option value="TIMESTAMP">По времени</option>
              <option value="LATENCY_MS">По задержке</option>
              <option value="AMOUNT_USD">По сумме USD</option>
              <option value="SEVERITY">По серьезности</option>
              <option value="TITLE">По заголовку</option>
              <option value="SOURCE">По источнику</option>
            </select>

            <button
              type="button"
              onClick={() => {
                setSortDir((d) => (d === 'DESC' ? 'ASC' : 'DESC'));
                setPage(1);
              }}
              className="h-8 px-2.5 text-xs font-mono font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md whitespace-nowrap"
            >
              {sortDir}
            </button>

            <button
              type="button"
              onClick={() => setShowQueryDrawer((v) => !v)}
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                showQueryDrawer
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              Динамический GraphQL
            </button>
          </div>
        </div>

        {/* Dynamic GraphQL Field Selector & AST Preview */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
            <span className="font-medium text-slate-800">Вложенные поля GraphQL:</span>
            {(
              [
                ['includeMetrics', 'metrics (ур. 2)'],
                ['includeService', 'service (ур. 2)'],
                ['includeCluster', 'cluster (ур. 3)'],
                ['includeRegion', 'region (ур. 4)'],
                ['includeIncidents', 'incidents (ур. 4)'],
                ['includeAuditTrail', 'auditTrail (ур. 3)'],
              ] as Array<[keyof DynamicFieldSelection, string]>
            ).map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={fieldSelection[key]}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFieldSelection((prev) => {
                      const next = { ...prev, [key]: checked };
                      if (key === 'includeService' && !checked) {
                        next.includeCluster = false;
                        next.includeRegion = false;
                        next.includeIncidents = false;
                      }
                      if (key === 'includeCluster' && checked) next.includeService = true;
                      if (key === 'includeCluster' && !checked) next.includeRegion = false;
                      if (key === 'includeRegion' && checked) {
                        next.includeService = true;
                        next.includeCluster = true;
                      }
                      if (key === 'includeIncidents' && checked) next.includeService = true;
                      return next;
                    });
                  }}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {lastTrace && (
            <div className="text-xs font-mono text-slate-500 tabular-nums">
              Глубина: {lastTrace.depth} · Сложность: {lastTrace.complexity} ·{' '}
              {lastTrace.cacheHit ? 'Кэш HIT' : 'DataLoader экономия: ' + lastTrace.loaderCallsSaved} ·{' '}
              {lastTrace.durationMs} мс
            </div>
          )}
        </div>

        {showQueryDrawer && (
          <div className="pt-3 border-t border-slate-100">
            <div className="text-xs font-medium text-slate-700 mb-1.5">
              Динамически сгенерированный GraphQL-запрос (отправляется на POST /graphql):
            </div>
            <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto max-h-56 leading-relaxed">
              {dynamicQuery}
            </pre>
          </div>
        )}
      </section>

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-xl text-xs font-medium">
          Ошибка GraphQL: {errorMsg}
        </div>
      )}

      {/* Records Data Grid */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 px-4">ID / Источник</th>
                <th className="py-2.5 px-4">Событие и категория</th>
                {fieldSelection.includeService && <th className="py-2.5 px-4">Топология (вложенность)</th>}
                <th className="py-2.5 px-4">Уровень · Статус</th>
                {fieldSelection.includeMetrics && (
                  <>
                    <th className="py-2.5 px-4 text-right">Задержка</th>
                    <th className="py-2.5 px-4 text-right">Сумма USD</th>
                  </>
                )}
                <th className="py-2.5 px-4 text-right">Время</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading && !connection ? (
                Array.from({ length: 8 }).map((_, idx) => (
                  <tr key={idx}>
                    <td colSpan={7} className="py-3 px-4">
                      <div className="h-4 bg-slate-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : connection && connection.items.length > 0 ? (
                connection.items.map((rec) => (
                  <tr
                    key={rec.id}
                    onClick={() => void openInspect(rec.id)}
                    className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <div className="font-mono font-semibold text-slate-900">{rec.externalId}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {rec.source} · {rec.rawFormat}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 max-w-sm">
                      <div className="font-medium text-slate-900 truncate">{rec.title}</div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {rec.category} · {rec.regionCode}
                        {rec.hasAnomaly ? ' · Аномалия' : ''}
                      </div>
                    </td>
                    {fieldSelection.includeService && (
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <div className="font-mono text-slate-800">{rec.service?.name ?? '—'}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {rec.service?.cluster?.name ?? rec.service?.ownerTeam ?? '—'}
                          {rec.service?.cluster?.region?.name
                            ? ` · ${rec.service.cluster.region.code}`
                            : ''}
                        </div>
                      </td>
                    )}
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <span className={severityColor(rec.severity)}>
                        {SEVERITY_LABELS[rec.severity]}
                      </span>
                      <span className="text-slate-300 mx-1.5">·</span>
                      <span className={statusColor(rec.status)}>
                        {STATUS_LABELS[rec.status]}
                      </span>
                    </td>
                    {fieldSelection.includeMetrics && (
                      <>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                          {rec.metrics ? `${rec.metrics.latencyMs.toFixed(1)} мс` : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {rec.metrics ? `$${rec.metrics.amountUsd.toFixed(2)}` : '—'}
                        </td>
                      </>
                    )}
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(rec.timestamp).toLocaleString('ru-RU', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    Записи по заданным фильтрам не найдены. Попробуйте сбросить фильтры.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/50 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
          <div className="tabular-nums">
            Найдено:{' '}
            <span className="font-semibold text-slate-900">
              {connection ? connection.totalCount.toLocaleString('ru-RU') : 0}
            </span>{' '}
            из {connection?.executionMeta.totalStoreRecords.toLocaleString('ru-RU') ?? '—'} записей
            {connection?.pageInfo.endCursor && (
              <span className="hidden md:inline text-slate-400 font-mono ml-3">
                cursor: {connection.pageInfo.endCursor}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <select
              aria-label="Размер страницы"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="h-8 px-2 bg-white border border-slate-200 rounded-md text-xs text-slate-700"
            >
              <option value={25}>25 / стр</option>
              <option value={50}>50 / стр</option>
              <option value={100}>100 / стр</option>
            </select>

            <div className="flex items-center gap-1.5 tabular-nums">
              <button
                type="button"
                disabled={!connection?.pageInfo.hasPreviousPage || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="h-8 px-2.5 inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Назад
              </button>
              <span className="px-2 font-mono">
                {connection?.pageInfo.currentPage ?? 1} / {connection?.pageInfo.totalPages ?? 1}
              </span>
              <button
                type="button"
                disabled={!connection?.pageInfo.hasNextPage || loading}
                onClick={() => setPage((p) => p + 1)}
                className="h-8 px-2.5 inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40"
              >
                Вперед
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Deep Record Inspection Drawer */}
      {inspectedRecord && (
        <div className="fixed inset-0 z-50 bg-slate-900/35 flex justify-end">
          <div className="w-full max-w-2xl bg-white h-full overflow-y-auto border-l border-slate-200 flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 sticky top-0 bg-white z-10">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  {inspectedRecord.externalId} · {inspectedRecord.source} ({inspectedRecord.rawFormat})
                </div>
                <h3 className="text-base font-semibold text-slate-900 mt-0.5">
                  {inspectedRecord.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setInspectedRecord(null)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-6 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-slate-500">Серьезность</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {SEVERITY_LABELS[inspectedRecord.severity]}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Статус</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {STATUS_LABELS[inspectedRecord.status]}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Задержка</div>
                  <div className="font-mono font-semibold text-slate-900 mt-1 tabular-nums">
                    {inspectedRecord.metrics?.latencyMs ?? 0} мс
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Сумма USD</div>
                  <div className="font-mono font-semibold text-slate-900 mt-1 tabular-nums">
                    ${inspectedRecord.metrics?.amountUsd.toFixed(2) ?? '0.00'}
                  </div>
                </div>
              </div>

              {/* 5-Level Topology Chain */}
              {inspectedRecord.service && (
                <div className="border-t border-slate-100 pt-4 space-y-2">
                  <div className="font-semibold text-slate-800">
                    Вложенная цепочка топологии (уровни 2–5)
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 font-mono">
                    <div>
                      Сервис: <span className="text-slate-900 font-semibold">{inspectedRecord.service.name}</span> ({inspectedRecord.service.ownerTeam})
                    </div>
                    {inspectedRecord.service.cluster && (
                      <div>
                        Кластер: <span className="text-slate-900 font-semibold">{inspectedRecord.service.cluster.name}</span> · K8s {inspectedRecord.service.cluster.kubernetesVersion}
                      </div>
                    )}
                    {inspectedRecord.service.cluster?.region && (
                      <div>
                        Регион: <span className="text-slate-900 font-semibold">{inspectedRecord.service.cluster.region.name}</span> ({inspectedRecord.service.cluster.region.complianceTier})
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Raw Source Payload */}
              {inspectedRecord.rawSnippet && (
                <div className="border-t border-slate-100 pt-4 space-y-2">
                  <div className="font-semibold text-slate-800">
                    Исходный фрагмент источника ({inspectedRecord.rawFormat})
                  </div>
                  <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg font-mono overflow-x-auto leading-relaxed">
                    {inspectedRecord.rawSnippet}
                  </pre>
                </div>
              )}

              {/* Status Mutation Controls */}
              <div className="border-t border-slate-100 pt-4 space-y-3">
                <div className="font-semibold text-slate-800">
                  GraphQL Мутация статуса и аудит
                </div>
                <input
                  type="text"
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="Комментарий к изменению статуса (необязательно)"
                  className="w-full h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'QUARANTINED'] as RecordStatus[]
                    ).map((st) => (
                      <button
                        key={st}
                        type="button"
                        disabled={inspectLoading || inspectedRecord.status === st}
                        onClick={() => void handleStatusUpdate(inspectedRecord.id, st)}
                        className="h-8 px-3 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md disabled:opacity-40"
                      >
                        {STATUS_LABELS[st]}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={inspectLoading}
                    onClick={() => void handleDeleteRecord(inspectedRecord.id)}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Удалить
                  </button>
                </div>
              </div>

              {/* Audit Trail */}
              <div className="border-t border-slate-100 pt-4 space-y-2">
                <div className="font-semibold text-slate-800">История изменений (Audit Trail)</div>
                <div className="space-y-2">
                  {(inspectedRecord.auditTrail ?? []).map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-50 last:border-0"
                    >
                      <div>
                        <span className="font-mono font-semibold text-slate-900">{ev.action}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-600">{ev.note}</span>
                        <div className="text-[11px] text-slate-400 mt-0.5">{ev.actor}</div>
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                        {new Date(ev.timestamp).toLocaleTimeString('ru-RU')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Record Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-lg bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Создать запись (GraphQL Mutation createRecord)
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Источник</label>
                  <select
                    value={createForm.source}
                    onChange={(e) =>
                      setCreateForm((p) => ({ ...p, source: e.target.value as DataSourceType }))
                    }
                    className="w-full h-9 px-2.5 border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="EDGE_LOGS">Edge Logs</option>
                    <option value="COMMERCE_LEDGER">Commerce Ledger</option>
                    <option value="IOT_TELEMETRY">IoT Telemetry</option>
                    <option value="SECURITY_AUDIT">Security Audit</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Серьезность</label>
                  <select
                    value={createForm.severity}
                    onChange={(e) =>
                      setCreateForm((p) => ({ ...p, severity: e.target.value as SeverityLevel }))
                    }
                    className="w-full h-9 px-2.5 border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="INFO">Инфо</option>
                    <option value="LOW">Низкая</option>
                    <option value="MEDIUM">Средняя</option>
                    <option value="HIGH">Высокая</option>
                    <option value="CRITICAL">Критическая</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Заголовок события</label>
                <input
                  required
                  type="text"
                  value={createForm.title}
                  onChange={(e) => setCreateForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Например: Ручная проверка шлюза оплаты"
                  className="w-full h-9 px-3 border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Микросервис</label>
                <select
                  value={createForm.serviceId}
                  onChange={(e) => setCreateForm((p) => ({ ...p, serviceId: e.target.value }))}
                  className="w-full h-9 px-2.5 border border-slate-200 rounded-lg bg-white font-mono"
                >
                  {availableServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Задержка (мс)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={createForm.latencyMs}
                    onChange={(e) =>
                      setCreateForm((p) => ({ ...p, latencyMs: Number(e.target.value) }))
                    }
                    className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Сумма (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={createForm.amountUsd}
                    onChange={(e) =>
                      setCreateForm((p) => ({ ...p, amountUsd: Number(e.target.value) }))
                    }
                    className="w-full h-9 px-3 border border-slate-200 rounded-lg font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="h-9 px-3.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="h-9 px-4 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Сохранить через GraphQL
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
