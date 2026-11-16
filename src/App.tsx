import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Code2,
  Database,
  GitBranch,
  LayoutDashboard,
  Menu,
  RefreshCw,
  X,
} from 'lucide-react';
import { ExplorerView } from './components/ExplorerView.tsx';
import { GovernanceTracingView } from './components/GovernanceTracingView.tsx';
import { OverviewView } from './components/OverviewView.tsx';
import { StudioView } from './components/StudioView.tsx';
import { TopologyView } from './components/TopologyView.tsx';
import { executeGraphQL } from './lib/graphqlClient.ts';
import type { DataSourceType, SystemTelemetry } from './types/graphql.ts';

type NavTab = 'overview' | 'explorer' | 'studio' | 'governance' | 'topology';

const TAB_TITLES: Record<NavTab, string> = {
  overview: 'Обзор и сбор данных',
  explorer: 'Обозреватель записей',
  studio: 'GraphQL Конструктор',
  governance: 'Контроль нагрузки и трассы',
  topology: 'Топология инфраструктуры',
};

const SYSTEM_TELEMETRY_QUERY = /* GraphQL */ `
  query SystemTelemetrySnapshot {
    systemTelemetry {
      totalRecords
      anomalyCount
      totalRegions
      totalClusters
      totalServices
      totalQueriesExecuted
      totalRejectedRequests
      totalLoaderCallsSaved
      uptimeSeconds
      collectors {
        source
        label
        format
        endpointLabel
        enabled
        circuitState
        faultMode
        consecutiveFailures
        totalCollected
        totalBatches
        totalFailures
        totalRetries
        lastRunAt
        lastDurationMs
        lastError
        nextRetryAt
      }
      rateLimiter {
        availableTokens
        burstCapacity
        maxRequestsPerMinute
        totalAllowed
        totalThrottled
      }
      cache {
        entries
        hits
        misses
        hitRatioPct
        ttlMs
      }
      latency {
        p50Ms
        p95Ms
        p99Ms
        requestsPerMinute
      }
      governance {
        maxRequestsPerMinute
        burstCapacity
        maxQueryDepth
        maxQueryComplexity
        cacheTtlMs
        autoCollectorEnabled
        autoCollectorIntervalMs
      }
      recentTraces(limit: 30) {
        traceId
        operationName
        operationType
        timestamp
        durationMs
        depth
        complexity
        cacheHit
        rateLimited
        loaderBatches
        loaderCallsSaved
        status
        errorCode
        spans {
          spanId
          parentSpanId
          name
          component
          startOffsetMs
          durationMs
          status
          metadata
        }
      }
    }
  }
`;

const COLLECT_ALL_MUTATION = /* GraphQL */ `
  mutation CollectAllSources {
    triggerIngestion(batchSize: 15) {
      totalIngested
      totalStoreRecords
    }
  }
`;

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [collectingAll, setCollectingAll] = useState(false);
  const [explorerSourceFilter, setExplorerSourceFilter] = useState<DataSourceType | null>(null);

  const refreshTelemetry = useCallback(async () => {
    const res = await executeGraphQL<{ systemTelemetry: SystemTelemetry }>(
      SYSTEM_TELEMETRY_QUERY,
      {},
      'SystemTelemetrySnapshot'
    );
    if (res.data?.systemTelemetry) {
      setTelemetry(res.data.systemTelemetry);
    }
  }, []);

  useEffect(() => {
    void refreshTelemetry();
    const timer = setInterval(() => {
      void refreshTelemetry();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshTelemetry]);

  const handleCollectAll = async () => {
    setCollectingAll(true);
    try {
      await executeGraphQL(COLLECT_ALL_MUTATION, {}, 'CollectAllSources');
      await refreshTelemetry();
    } finally {
      setCollectingAll(false);
    }
  };

  const navItems: Array<{ id: NavTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'Обзор и сбор', icon: LayoutDashboard },
    { id: 'explorer', label: 'Обозреватель', icon: Database },
    { id: 'studio', label: 'GraphQL Студия', icon: Code2 },
    { id: 'governance', label: 'Нагрузка и трассы', icon: Activity },
    { id: 'topology', label: 'Топология', icon: GitBranch },
  ];

  const handleNavClick = (id: NavTab) => {
    setActiveTab(id);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            GraphPulse
          </span>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">Протокол обмена</div>
          <div className="font-mono">Только POST /graphql</div>
          <div className="tabular-nums">
            Записей: {telemetry ? telemetry.totalRecords.toLocaleString('ru-RU') : '—'}
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden bg-slate-900/40 flex">
          <div className="w-64 bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-lg font-bold tracking-tight text-slate-900">GraphPulse</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-800 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="p-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Открыть меню"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span className="font-medium text-slate-900">GraphPulse</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="text-slate-700 font-medium">{TAB_TITLES[activeTab]}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden md:block text-xs font-mono text-slate-500 tabular-nums">
              {telemetry
                ? `${telemetry.totalRecords.toLocaleString('ru-RU')} зап. · Токены ${telemetry.rateLimiter.availableTokens}/${telemetry.rateLimiter.burstCapacity}`
                : 'Загрузка...'}
            </div>

            <button
              type="button"
              disabled={collectingAll}
              onClick={() => void handleCollectAll()}
              className="h-9 px-4 inline-flex items-center gap-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${collectingAll ? 'animate-spin' : ''}`} />
              {collectingAll ? 'Сбор...' : 'Собрать батч'}
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewView
              telemetry={telemetry}
              onRefreshTelemetry={refreshTelemetry}
              onNavigateToExplorer={(src) => {
                setExplorerSourceFilter(src ?? null);
                setActiveTab('explorer');
              }}
            />
          )}

          {activeTab === 'explorer' && (
            <ExplorerView
              initialSourceFilter={explorerSourceFilter}
              onClearInitialSource={() => setExplorerSourceFilter(null)}
              onDataMutated={refreshTelemetry}
            />
          )}

          {activeTab === 'studio' && <StudioView onDataMutated={refreshTelemetry} />}

          {activeTab === 'governance' && (
            <GovernanceTracingView
              telemetry={telemetry}
              onRefreshTelemetry={refreshTelemetry}
            />
          )}

          {activeTab === 'topology' && <TopologyView />}
        </main>
      </div>
    </div>
  );
}
