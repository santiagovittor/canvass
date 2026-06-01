import { useState, useCallback } from 'react';
import type { Business } from '../types';

export function useResults() {
  const [results, setResultsState] = useState<Business[]>([]);
  const [businessCount, setBusinessCount] = useState(0);
  const [cellsDone, setCellsDone] = useState(0);
  const [enrichedTotal, setEnrichedTotal] = useState(0);
  const [enrichedDone, setEnrichedDone] = useState(0);

  const addResult = useCallback((result: Business) => {
    setResultsState(prev => [result, ...prev]);
  }, []);

  const setResults = useCallback((items: Business[]) => {
    setResultsState(items);
  }, []);

  const updateProgress = useCallback((done: number) => {
    setCellsDone(done);
  }, []);

  const updateBusinessCount = useCallback((count: number) => {
    setBusinessCount(count);
  }, []);

  const updateEnrichProgress = useCallback((done: number, total: number) => {
    setEnrichedDone(done);
    setEnrichedTotal(total);
  }, []);

  const reset = useCallback(() => {
    setResultsState([]);
    setBusinessCount(0);
    setCellsDone(0);
    setEnrichedDone(0);
    setEnrichedTotal(0);
  }, []);

  return { results, businessCount, cellsDone, enrichedDone, enrichedTotal, addResult, setResults, updateProgress, updateBusinessCount, updateEnrichProgress, reset };
}
