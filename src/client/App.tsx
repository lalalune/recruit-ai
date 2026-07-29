import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { AppShell } from "./components/AppShell";

const DiscoverPage = lazy(() =>
  import("./pages/DiscoverPage").then((module) => ({
    default: module.DiscoverPage,
  })),
);
const ReviewPage = lazy(() =>
  import("./pages/ReviewPage").then((module) => ({
    default: module.ReviewPage,
  })),
);
const OutreachPage = lazy(() =>
  import("./pages/OutreachPage").then((module) => ({
    default: module.OutreachPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);

export function App() {
  return (
    <Suspense
      fallback={
        <div className="route-loading" role="status">
          Loading workspace…
        </div>
      }
    >
      <AppShell>
        <Switch>
          <Route path="/discover">
            <DiscoverPage />
          </Route>
          <Route path="/review/:companyId">
            <ReviewPage />
          </Route>
          <Route path="/review">
            <ReviewPage />
          </Route>
          <Route path="/outreach/:draftId">
            <OutreachPage />
          </Route>
          <Route path="/outreach">
            <OutreachPage />
          </Route>
          <Route path="/settings">
            <SettingsPage />
          </Route>
          <Route path="*">
            <Redirect replace to="/discover" />
          </Route>
        </Switch>
      </AppShell>
    </Suspense>
  );
}
