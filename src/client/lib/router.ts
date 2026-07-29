import { useLocation } from "wouter";

export { Link, useLocation, useParams, useSearchParams } from "wouter";

/**
 * Compatibility hook for imperative navigation.
 *
 * Keeping this tiny adapter gives pages a single navigation function while
 * Wouter owns History API updates and back/forward subscriptions.
 */
export function useNavigate() {
  const [, navigate] = useLocation();
  return navigate;
}
