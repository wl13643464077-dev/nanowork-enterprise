import { Agent } from 'undici';

const imageAgent = new Agent();

// Node fetch supplies its own 300s parser deadline even when AbortSignal has a
// longer budget. Image jobs may need 15 minutes before the first response byte.
// Override only these image requests; the caller's AbortSignal still enforces
// the total deadline, cancellation, and shutdown. No retry is added here.
export function imageHttpDispatcher(timeoutMs, agent = imageAgent) {
  const deadline = Math.min(900000, Math.max(1000, Number(timeoutMs) || 105000));
  return {
    dispatch(options, handler) {
      return agent.dispatch({ ...options, headersTimeout: deadline, bodyTimeout: deadline }, handler);
    },
  };
}
