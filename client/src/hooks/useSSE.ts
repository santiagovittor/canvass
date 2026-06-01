import { useEffect, useRef, useState } from 'react';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'idle';

let es: EventSource | null = null;
let esListeners = 0;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const globalHandlers = new Map<string, Set<(data: unknown) => void>>();
const statusSubscribers = new Set<(s: ConnectionStatus) => void>();
let currentStatus: ConnectionStatus = 'idle';

function setStatus(s: ConnectionStatus) {
  if (s === currentStatus) return;
  currentStatus = s;
  statusSubscribers.forEach(fn => fn(s));
}

function dispatchEvent(eventName: string, raw: string) {
  try {
    const data = JSON.parse(raw);
    backoffMs = 1000;
    setStatus('connected');
    globalHandlers.get(eventName)?.forEach(fn => fn(data));
  } catch {}
}

function attachListeners(src: EventSource) {
  src.onmessage = (e: MessageEvent) => dispatchEvent('message', e.data);
  src.onerror = () => {
    if (esListeners > 0) {
      es?.close();
      es = null;
      setStatus('reconnecting');
      scheduleReconnect();
    }
  };
  for (const eventName of globalHandlers.keys()) {
    if (eventName !== 'message') {
      src.addEventListener(eventName, (e: Event) =>
        dispatchEvent(eventName, (e as MessageEvent).data)
      );
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (esListeners > 0) createES();
  }, delay);
}

function createES() {
  if (es) { es.close(); es = null; }
  es = new EventSource('/events');
  attachListeners(es);
}

export function useSSE(
  handlers: Record<string, (data: unknown) => void>,
): { connectionStatus: ConnectionStatus } {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(currentStatus);

  useEffect(() => {
    statusSubscribers.add(setConnectionStatus);
    setConnectionStatus(currentStatus);
    return () => { statusSubscribers.delete(setConnectionStatus); };
  }, []);

  useEffect(() => {
    esListeners++;
    if (!es || es.readyState === EventSource.CLOSED) {
      backoffMs = 1000;
      createES();
    }

    const src = es!;
    const cleanups: (() => void)[] = [];

    for (const [eventName] of Object.entries(handlers)) {
      const wrapper = (data: unknown) => handlersRef.current[eventName]?.(data);

      if (!globalHandlers.has(eventName)) {
        globalHandlers.set(eventName, new Set());
        if (eventName !== 'message') {
          src.addEventListener(eventName, (e: Event) =>
            dispatchEvent(eventName, (e as MessageEvent).data)
          );
        }
      }
      globalHandlers.get(eventName)!.add(wrapper);
      cleanups.push(() => { globalHandlers.get(eventName)?.delete(wrapper); });
    }

    return () => {
      esListeners--;
      for (const cleanup of cleanups) cleanup();
      if (esListeners === 0) {
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        es?.close();
        es = null;
        setStatus('idle');
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { connectionStatus };
}
