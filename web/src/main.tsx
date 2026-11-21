import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Shell, usePath } from "./ui";
import Landing from "./pages/Landing";
const Trade = lazy(() => import("./pages/Trade"));
import Proof from "./pages/Proof";
import BatchPage from "./pages/BatchPage";

function Router() {
  const path = usePath();
  const m = path.match(/^\/batch\/(\d+)\/?$/);
  const page = path === "/app" || path === "/app/" ? <Suspense fallback={<div className="page wrap"><div className="empty">Loading the trade screen.</div></div>}><Trade /></Suspense>
    : path === "/proof" || path === "/proof/" ? <Proof />
    : m ? <BatchPage id={Number(m[1])} />
    : <Landing />;
  return <Shell path={path}>{page}</Shell>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Router /></StrictMode>);
