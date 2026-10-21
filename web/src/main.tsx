import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { isSandbox } from "./sandbox";
import { SandboxBanner } from "./components/SandboxBanner";
import { AppLayout } from "./components/AppLayout";
import { AdminBackupPage } from "./admin/AdminBackupPage";
import { AdminApiConsolePage } from "./admin/AdminApiConsolePage";
import { AdminDangerPage } from "./admin/AdminDangerPage";
import { AdminEnvPage } from "./admin/AdminEnvPage";
import { AdminHomePage } from "./admin/AdminHomePage";
import { AdminLayout } from "./admin/AdminLayout";
import { AdminResetPage } from "./admin/AdminResetPage";
import { AdminSettingsPage } from "./admin/AdminSettingsPage";
import { AdminSqlPage } from "./admin/AdminSqlPage";
import { AdminSystemPage } from "./admin/AdminSystemPage";
import { AdminUsersPage } from "./admin/AdminUsersPage";
import { AuditsPage } from "./pages/AuditsPage";
import { CycleCountPage } from "./pages/CycleCountPage";
import { BatchDetailPage } from "./pages/BatchDetailPage";
import { BatchesPage } from "./pages/BatchesPage";
import { IntakePage } from "./pages/IntakePage";
import { InventoryPage } from "./pages/InventoryPage";
import { LoginPage } from "./pages/LoginPage";
import { OrdersPage } from "./pages/OrdersPage";
import { PartDetailPage } from "./pages/PartDetailPage";
import { PartLabelsPage } from "./pages/PartLabelsPage";
import { PriceAuditPage } from "./pages/PriceAuditPage";
import { PurchaseOrderCreatePage } from "./pages/PurchaseOrderCreatePage";
import { PurchaseOrderDetailPage } from "./pages/PurchaseOrderDetailPage";
import { PurchaseOrderLabelsPage } from "./pages/PurchaseOrderLabelsPage";
import { PurchaseOrderReceivePage } from "./pages/PurchaseOrderReceivePage";
import { RedeemPage } from "./pages/RedeemPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RmaPage } from "./pages/RmaPage";
import { RmaDetailPage } from "./pages/RmaDetailPage";
import { ReturnDetailPage } from "./pages/ReturnDetailPage";
import { BuybackPage } from "./pages/BuybackPage";
import { BuybackDetailPage } from "./pages/BuybackDetailPage";
import { CountingPage } from "./pages/CountingPage";
import { SearchPage } from "./pages/SearchPage";
import { SkuDetailPage } from "./pages/SkuDetailPage";
import { UsersPage } from "./pages/UsersPage";
import "./styles.css";

// Sandbox guardrail (spec decision 10): the tab title differs so a trainee
// can never mistake the two environments, before any page renders.
if (isSandbox) {
  document.title = "RMS (SANDBOX)";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The guardrail banner lives at the app root, outside route content —
        no page, login or redeem included, can render without it. */}
    <SandboxBanner />
    <AuthProvider>
      {/* basename (sandbox spec decision 3): in the sandbox every existing
          absolute route path keeps working under the /sandbox prefix. */}
      <BrowserRouter basename={isSandbox ? "/sandbox" : "/"}>
        <Routes>
          {/* Public: the login flow itself. */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/redeem" element={<RedeemPage />} />
          {/* The admin surface (ticket 18): its OWN layout and its OWN key
              auth — deliberately outside the RequireAuth wrapper and never
              linked from the main app's navigation; the owner types the URL.
              A main-app session grants nothing here. */}
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminHomePage />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
            <Route path="env" element={<AdminEnvPage />} />
            <Route path="backup" element={<AdminBackupPage />} />
            {/* Sandbox reset (sandbox ticket 05): sandbox-only surface — the
                routes only exist on the sandbox instance, so the prod panel
                never renders the page either. */}
            <Route path="reset" element={<AdminResetPage />} />
            <Route path="danger" element={<AdminDangerPage />} />
            <Route path="sql" element={<AdminSqlPage />} />
            <Route path="api-console" element={<AdminApiConsolePage />} />
            <Route path="system" element={<AdminSystemPage />} />
          </Route>
          {/* Everything else requires a session; Users is manager-only. */}
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/batches" replace />} />
            <Route path="batches" element={<BatchesPage />} />
            <Route path="batches/:id" element={<BatchDetailPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="inventory/intake" element={<IntakePage />} />
            <Route path="inventory/labels" element={<PartLabelsPage />} />
            <Route path="inventory/skus/:id" element={<SkuDetailPage />} />
            <Route path="inventory/parts/:serial" element={<PartDetailPage />} />
            <Route path="inventory/price-audit" element={<PriceAuditPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/new" element={<PurchaseOrderCreatePage />} />
            <Route path="orders/:id/labels" element={<PurchaseOrderLabelsPage />} />
            <Route path="orders/:id/receive" element={<PurchaseOrderReceivePage />} />
            <Route path="orders/:id" element={<PurchaseOrderDetailPage />} />
            <Route path="rma" element={<RmaPage />} />
            <Route path="rma/returns/:id" element={<ReturnDetailPage />} />
            <Route path="rma/:id" element={<RmaDetailPage />} />
            <Route path="buyback" element={<BuybackPage />} />
            <Route path="buyback/:id" element={<BuybackDetailPage />} />
            <Route path="counting" element={<CountingPage />} />
            {/* Ticket 26: the old counting routes redirect to the merged page. */}
            <Route path="audits" element={<Navigate to="/counting" replace />} />
            <Route path="cycle-count" element={<Navigate to="/counting" replace />} />
            <Route path="audits" element={<AuditsPage />} />
            <Route path="cycle-count" element={<CycleCountPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="users" element={<UsersPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>,
);
