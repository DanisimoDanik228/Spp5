import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  type SelectionSetNode,
} from 'graphql';
import { store } from './store.ts';
import type { TraceSpan } from './types.ts';

export class TokenBucketLimiter {
  private tokens: number;
  private lastRefillMs: number;
  public totalAllowed = 0;
  public totalThrottled = 0;

  constructor() {
    this.tokens = store.governance.burstCapacity;
    this.lastRefillMs = Date.now();
  }

  public syncCapacity(): void {
    this.refill();
    this.tokens = Math.min(this.tokens, store.governance.burstCapacity);
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;
    const ratePerMs = store.governance.maxRequestsPerMinute / 60000;
    this.tokens = Math.min(store.governance.burstCapacity, this.tokens + elapsedMs * ratePerMs);
  }

  public tryConsume(): {
    allowed: boolean;
    remainingTokens: number;
    capacity: number;
    retryAfterMs: number;
  } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.totalAllowed++;
      return {
        allowed: true,
        remainingTokens: Number(this.tokens.toFixed(2)),
        capacity: store.governance.burstCapacity,
        retryAfterMs: 0,
      };
    }
    this.totalThrottled++;
    const ratePerMs = store.governance.maxRequestsPerMinute / 60000;
    const retryAfterMs = Math.ceil((1 - this.tokens) / Math.max(ratePerMs, 0.0001));
    return {
      allowed: false,
      remainingTokens: 0,
      capacity: store.governance.burstCapacity,
      retryAfterMs,
    };
  }

  public snapshot() {
    this.refill();
    return {
      availableTokens: Number(this.tokens.toFixed(2)),
      burstCapacity: store.governance.burstCapacity,
      maxRequestsPerMinute: store.governance.maxRequestsPerMinute,
      totalAllowed: this.totalAllowed,
      totalThrottled: this.totalThrottled,
    };
  }
}

export const rateLimiter = new TokenBucketLimiter();

export interface ComplexityAnalysis {
  depth: number;
  complexity: number;
  fieldCount: number;
  operationType: string;
  operationName: string;
}

const LIST_FIELD_MULTIPLIER_FIELDS = new Set([
  'records',
  'items',
  'edges',
  'regions',
  'clusters',
  'services',
  'relatedIncidents',
  'auditTrail',
  'aggregations',
  'recentTraces',
  'collectors',
]);

export function analyzeGraphQLDocument(
  doc: DocumentNode,
  variables: Record<string, unknown> = {},
  requestedOperationName?: string
): ComplexityAnalysis {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    }
  }

  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  const targetOp =
    (requestedOperationName
      ? ops.find((o) => o.name?.value === requestedOperationName)
      : undefined) ?? ops[0];

  if (!targetOp) {
    return {
      depth: 0,
      complexity: 0,
      fieldCount: 0,
      operationType: 'query',
      operationName: 'anonymous',
    };
  }

  let maxDepth = 0;
  let fieldCount = 0;

  const extractListMultiplier = (field: FieldNode): number => {
    if (!LIST_FIELD_MULTIPLIER_FIELDS.has(field.name.value)) return 1;
    if (field.name.value === 'records' || field.name.value === 'items' || field.name.value === 'edges') {
      // Inspect pagination argument if present
      const pagArg = field.arguments?.find((a) => a.name.value === 'pagination');
      if (pagArg && pagArg.value.kind === Kind.OBJECT) {
        for (const f of pagArg.value.fields) {
          if (f.name.value === 'pageSize' || f.name.value === 'first') {
            if (f.value.kind === Kind.INT) {
              return Math.min(100, Math.max(1, Number(f.value.value)));
            }
            if (f.value.kind === Kind.VARIABLE) {
              const varObj = variables[f.value.name.value];
              if (typeof varObj === 'number') return Math.min(100, Math.max(1, varObj));
            }
          }
        }
      }
      if (pagArg && pagArg.value.kind === Kind.VARIABLE) {
        const varVal = variables[pagArg.value.name.value] as Record<string, unknown> | undefined;
        const size = Number(varVal?.pageSize ?? varVal?.first ?? 25);
        if (Number.isFinite(size)) return Math.min(100, Math.max(1, size));
      }
      return field.name.value === 'records' ? 20 : 1;
    }
    return 4;
  };

  const walkSelectionSet = (
    selectionSet: SelectionSetNode | undefined,
    currentDepth: number,
    multiplier: number,
    visitedFragments: Set<string>
  ): number => {
    if (!selectionSet) return 0;
    let cost = 0;

    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) {
          fieldCount++;
          cost += 1;
          continue;
        }
        fieldCount++;
        const nextDepth = currentDepth + 1;
        if (nextDepth > maxDepth) maxDepth = nextDepth;

        const childMult = extractListMultiplier(sel);
        const selfCost = sel.selectionSet ? 2 : 1;
        const childCost = walkSelectionSet(
          sel.selectionSet,
          nextDepth,
          Math.min(100, multiplier * (childMult > 1 ? Math.ceil(childMult / 5) : 1)),
          visitedFragments
        );
        cost += selfCost * multiplier + childCost;
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        cost += walkSelectionSet(sel.selectionSet, currentDepth, multiplier, visitedFragments);
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const fragName = sel.name.value;
        if (!visitedFragments.has(fragName)) {
          visitedFragments.add(fragName);
          const frag = fragments.get(fragName);
          if (frag) {
            cost += walkSelectionSet(frag.selectionSet, currentDepth, multiplier, visitedFragments);
          }
        }
      }
    }
    return cost;
  };

  const complexity = walkSelectionSet(targetOp.selectionSet, 0, 1, new Set<string>());

  return {
    depth: maxDepth,
    complexity,
    fieldCount,
    operationType: targetOp.operation,
    operationName: targetOp.name?.value ?? `${targetOp.operation}:inline`,
  };
}

export class TraceRecorder {
  public readonly traceId: string;
  private readonly startPerf: number;
  private readonly spans: TraceSpan[] = [];
  private spanSeq = 1;

  constructor() {
    const rand = Math.random().toString(36).slice(2, 8);
    this.traceId = `tr_${Date.now().toString(36)}_${rand}`;
    this.startPerf = performance.now();
  }

  public addSpan(
    name: string,
    component: string,
    startPerfMs: number,
    endPerfMs: number,
    status: TraceSpan['status'] = 'OK',
    metadata = '',
    parentSpanId: string | null = null
  ): string {
    const spanId = `sp_${this.spanSeq++}`;
    this.spans.push({
      spanId,
      parentSpanId,
      name,
      component,
      startOffsetMs: Number(Math.max(0, startPerfMs - this.startPerf).toFixed(3)),
      durationMs: Number(Math.max(0.01, endPerfMs - startPerfMs).toFixed(3)),
      status,
      metadata,
    });
    return spanId;
  }

  public getElapsedMs(): number {
    return Number(Math.max(0.05, performance.now() - this.startPerf).toFixed(3));
  }

  public getSpans(): TraceSpan[] {
    return this.spans;
  }
}
