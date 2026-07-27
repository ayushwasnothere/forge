import { BrowserRouter, Route, Routes } from "react-router-dom";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<div className="p-10">Forge — home (placeholder)</div>} />
        <Route path="*" element={<div className="p-10">Not found</div>} />
      </Routes>
    </BrowserRouter>
  );
}
