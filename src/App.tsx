console.log("ENV CHECK =>", {
  url: import.meta.env.VITE_SUPABASE_URL,
  key: import.meta.env.VITE_SUPABASE_ANON_KEY,
});
import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Droplets, Flame, RefreshCw, Undo2, Share2, Wifi, PlusCircle, Trash2, Pencil } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import { createClient } from "@supabase/supabase-js";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Vaso Emocional — Versión multi-vasos en paralelo (opción B)
 * - Muestra varios vasos a la vez dentro de una misma sala (#room=...)
 * - Cada vaso tiene su propio estado, eventos e historial
 * - Sincronización en tiempo real vía Supabase (si hay claves .env)
 * - Permite crear/renombrar/eliminar vasos (mínimo 1)
 */

// ---------- Utilidades ----------
const STORAGE_KEY = "vaso-emocional-multi-v1";

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function todayISO() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(aISO: string, bISO: string) {
  const a = new Date(aISO + "T00:00:00");
  const b = new Date(bISO + "T00:00:00");
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ---------- Tipos ----------
export type Evento = { id: string; dateISO: string; label: string; drops: number };
export type Punto = { dateISO: string; level: number };
export type Vaso = {
  id: string;
  name: string;
  capacity: number;
  threshold: number;
  evaporationPerDay: number;
  level: number;
  lastUpdateISO: string;
  events: Evento[];
  history: Punto[];
  autoDailyTick: boolean;
};

export type State = {
  vasos: Record<string, Vaso>; // por id
  order: string[]; // orden visual de vasos
  createdAtISO: string;
};

// ---------- Estado por defecto ----------
const defaultVaso = (name: string): Vaso => ({
  id: uid(),
  name,
  capacity: 100,
  threshold: 60,
  evaporationPerDay: 2,
  level: 15,
  lastUpdateISO: todayISO(),
  events: [],
  history: [],
  autoDailyTick: true,
});

const bootstrapState = (): State => {
  const a = defaultVaso("Mi vaso");
  const b = defaultVaso("Su vaso");
  const c = defaultVaso("Compartido");
  return {
    vasos: { [a.id]: a, [b.id]: b, [c.id]: c },
    order: [a.id, b.id, c.id],
    createdAtISO: todayISO(),
  };
};

// ---------- SUPABASE ----------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = supabaseUrl && supabaseAnon ? createClient(supabaseUrl, supabaseAnon) : null;

type SaveStatus = "idle" | "saving" | "saved" | "error";

function getOrCreateRoomId() {
  const m = location.hash.match(/room=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const id = uid();
  const url = new URL(location.href);
  url.hash = `room=${id}`;
  history.replaceState(null, "", url.toString());
  return id;
}

function useDebounced<T extends any[]>(fn: (...args: T) => void, ms = 600) {
  const t = React.useRef<number | null>(null);
  return (...args: T) => {
    if (t.current) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => fn(...args), ms);
  };
}

// ---------- Migración desde versión de 1 solo vaso ----------
function migrateIfNeeded(raw: any): State {
  if (!raw) return bootstrapState();
  // Detecta antiguo shape: tenía capacity/threshold/level al tope
  if (raw && typeof raw === "object" && "capacity" in raw && "threshold" in raw) {
    const solo = raw as any;
    const me = defaultVaso("Mi vaso");
    me.capacity = solo.capacity ?? me.capacity;
    me.threshold = solo.threshold ?? me.threshold;
    me.evaporationPerDay = solo.evaporationPerDay ?? me.evaporationPerDay;
    me.level = solo.level ?? me.level;
    me.lastUpdateISO = solo.lastUpdateISO ?? me.lastUpdateISO;
    me.events = Array.isArray(solo.events) ? solo.events : [];
    me.history = Array.isArray(solo.history) ? solo.history : [];
    me.autoDailyTick = solo.autoDailyTick ?? true;
    const other1 = defaultVaso("Su vaso");
    const other2 = defaultVaso("Compartido");
    return { vasos: { [me.id]: me, [other1.id]: other1, [other2.id]: other2 }, order: [me.id, other1.id, other2.id], createdAtISO: todayISO() };
  }
  // Si ya es multi
  if (raw && raw.vasos && raw.order) return raw as State;
  return bootstrapState();
}

// ---------- Componente principal ----------
export default function VasoEmocionalApp() {
  const [roomId] = useState(getOrCreateRoomId());
  const [state, setState] = useState<State>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return migrateIfNeeded(raw);
    } catch {
      return bootstrapState();
    }
  });
   const [online] = useState<boolean>(!!supabase);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [lastError, setLastError] = useState<string | null>(null);

  // Carga inicial y realtime Supabase
 useEffect(() => {
  if (!supabase) return;
  let channel: RealtimeChannel | null = null;
(async () => {
    // (opcional) tu upsert/select inicial aquí…

    // Crear y suscribir canal
    channel = supabase
      .channel(`rooms-${roomId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        (payload) => {
          const newData = (payload.new as any).data;
          if (newData) {
            const migrated = migrateIfNeeded(newData);
            setState(migrated);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          }
        }
      )
      .subscribe(); // devuelve RealtimeChannel
  })();

  // Cleanup SIN devolver una promesa y con null-check
  return () => {
    if (channel) {
      void channel.unsubscribe();
    }
  };
}, [roomId]);


  // Persistencia local
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // Evaporación por vaso al iniciar
  useEffect(() => {
    const today = todayISO();
    setState((prev) => {
      const next = { ...prev, vasos: { ...prev.vasos } };
      for (const id of prev.order) {
        const v = { ...prev.vasos[id] };
        if (v.autoDailyTick && v.lastUpdateISO !== today) {
          const days = daysBetween(v.lastUpdateISO, today);
          if (days > 0) {
            const newHistory = [...v.history];
            let lvl = v.level;
            for (let i = 1; i <= days; i++) {
              const d = new Date(v.lastUpdateISO + "T00:00:00");
              d.setDate(d.getDate() + i);
              const dISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              lvl = Math.max(0, Math.min(v.capacity, lvl - v.evaporationPerDay));
              newHistory.push({ dateISO: dISO, level: lvl });
            }
            v.level = lvl;
            v.lastUpdateISO = today;
            v.history = newHistory.slice(-180);
            next.vasos[id] = v;
          }
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push a la nube (debounced)
  const pushToCloudDebounced = useDebounced(async (snapshot: State) => {
    if (!supabase) return;
    try {
      setSaveStatus("saving");
      await supabase.from("rooms").upsert({ id: roomId, data: snapshot, updated_at: new Date().toISOString() });
      setSaveStatus("saved");
      setLastError(null);
    } catch (e: any) {
      setSaveStatus("error");
      setLastError(e?.message || String(e));
    }
  }, 600);

  async function pushToCloudImmediate(snapshot: State) {
    if (!supabase) return;
    try {
      setSaveStatus("saving");
      await supabase.from("rooms").upsert({ id: roomId, data: snapshot, updated_at: new Date().toISOString() });
      setSaveStatus("saved");
      setLastError(null);
    } catch (e: any) {
      setSaveStatus("error");
      setLastError(e?.message || String(e));
    }
  }

  useEffect(() => {
    if (!supabase) return;
    pushToCloudDebounced(state);
  }, [JSON.stringify(state)]);

  // Garantiza guardado antes de cerrar/ocultar la pestaña
  useEffect(() => {
    if (!supabase) return;
    const handler = () => {
      // mejor esfuerzo; no await
      supabase.from("rooms").upsert({ id: roomId, data: state, updated_at: new Date().toISOString() });
    };
    window.addEventListener("beforeunload", handler);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") handler();
    });
    return () => window.removeEventListener("beforeunload", handler);
  }, [JSON.stringify(state)]);

  // ---------- Mutadores ----------
  function updateVaso(id: string, patch: Partial<Vaso>) {
    setState((prev) => ({
      ...prev,
      vasos: { ...prev.vasos, [id]: { ...prev.vasos[id], ...patch } },
    }));
  }

  function addEvent(id: string, label: string, drops: number) {
    const labelFinal = label.trim() || "Evento";
    setState((prev) => {
      const v = prev.vasos[id];
      const lvl = Math.max(0, Math.min(v.capacity, v.level + drops));
      const evt: Evento = { id: uid(), dateISO: todayISO(), label: labelFinal, drops };
      const vh: Vaso = {
        ...v,
        level: lvl,
        events: [evt, ...v.events].slice(0, 100),
        history: [...v.history, { dateISO: todayISO(), level: lvl }].slice(-180),
        lastUpdateISO: todayISO(),
      };
      return { ...prev, vasos: { ...prev.vasos, [id]: vh } };
    });
  }

  function undoLast(id: string) {
    setState((prev) => {
      const v = prev.vasos[id];
      const [last, ...rest] = v.events;
      if (!last) return prev;
      const lvl = Math.max(0, Math.min(v.capacity, v.level - last.drops));
      const vh: Vaso = {
        ...v,
        level: lvl,
        events: rest,
        history: [...v.history, { dateISO: todayISO(), level: lvl }].slice(-180),
        lastUpdateISO: todayISO(),
      };
      return { ...prev, vasos: { ...prev.vasos, [id]: vh } };
    });
  }

  function createVaso() {
    const name = prompt("Nombre del vaso:", "Nuevo vaso");
    if (!name) return;
    const v = defaultVaso(name);
    setState((prev) => ({
      ...prev,
      vasos: { ...prev.vasos, [v.id]: v },
      order: [...prev.order, v.id],
    }));
  }

  function renameVaso(id: string) {
    const curr = state.vasos[id];
    const name = prompt("Renombrar vaso:", curr.name);
    if (!name) return;
    updateVaso(id, { name });
  }

  function deleteVaso(id: string) {
    if (state.order.length <= 1) {
      alert("Debe existir al menos un vaso.");
      return;
    }
    if (!confirm("¿Eliminar este vaso? Esta acción no se puede deshacer.")) return;
    setState((prev) => {
      const { [id]: _, ...rest } = prev.vasos;
      const newOrder = prev.order.filter((x) => x !== id);
      return { ...prev, vasos: rest, order: newOrder };
    });
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen w-full bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-2xl font-semibold">
            <Droplets className="h-6 w-6" /> Vaso emocional — multi
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            {supabase ? (
              <span className="inline-flex items-center gap-1"><Wifi className={`h-4 w-4 ${online ? "opacity-100" : "opacity-40"}`} /> {online ? "Conectado" : "Conectando..."}</span>
            ) : (
              <span className="opacity-70">Sin nube</span>
            )}
            <span className={`px-2 py-0.5 rounded-full border ${saveStatus === "saved" ? "border-emerald-200 text-emerald-700 bg-emerald-50" : saveStatus === "saving" ? "border-amber-200 text-amber-700 bg-amber-50" : saveStatus === "error" ? "border-rose-200 text-rose-700 bg-rose-50" : "border-slate-200 text-slate-600 bg-white"}`}>
              {saveStatus === "saved" && "Guardado"}
              {saveStatus === "saving" && "Guardando…"}
              {saveStatus === "error" && (lastError ? `Error: ${lastError}` : "Error")}
              {saveStatus === "idle" && ""}
            </span>
            <Button variant="outline" className="rounded-2xl" onClick={() => pushToCloudImmediate(state)}>Guardar ahora</Button>
            <Button variant="secondary" className="rounded-2xl inline-flex gap-2" onClick={() => navigator.clipboard.writeText(location.href).then(()=>alert("Enlace copiado"))}>
              <Share2 className="h-4 w-4"/> Compartir
            </Button>
            <Button className="rounded-2xl inline-flex gap-2" onClick={createVaso}>
              <PlusCircle className="h-4 w-4"/> Añadir vaso
            </Button>
          </div>
        </div>

        {/* Grid de vasos */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {state.order.map((id) => (
            <VasoCard
              key={id}
              vaso={state.vasos[id]}
              onChange={(patch) => updateVaso(id, patch)}
              onAddEvent={(label, drops) => addEvent(id, label, drops)}
              onUndo={() => undoLast(id)}
              onRename={() => renameVaso(id)}
              onDelete={() => deleteVaso(id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Subcomponente: Tarjeta de Vaso ----------
function VasoCard({
  vaso,
  onChange,
  onAddEvent,
  onUndo,
  onRename,
  onDelete,
}: {
  vaso: Vaso;
  onChange: (patch: Partial<Vaso>) => void;
  onAddEvent: (label: string, drops: number) => void;
  onUndo: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const percent = useMemo(() => (vaso.level / vaso.capacity) * 100, [vaso.level, vaso.capacity]);
  const inRedZone = vaso.level >= vaso.threshold;
  const [label, setLabel] = useState("");
  const [drops, setDrops] = useState(3);

  const chartData = useMemo(() => {
    const dedup = new Map<string, number>();
    for (const h of vaso.history) dedup.set(h.dateISO, h.level);
    dedup.set(todayISO(), vaso.level);
    return Array.from(dedup, ([dateISO, level]) => ({ dateISO, level })).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  }, [vaso.history, vaso.level]);

  function quickAdd(size: "small" | "medium" | "large") {
    const map = { small: 2, medium: 4, large: 8 } as const;
    onAddEvent(size === "small" ? "Molestia pequeña" : size === "medium" ? "Problema mediano" : "Conflicto grande", map[size]);
  }

  return (
    <Card className="shadow-xl">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl flex items-center gap-2">
            {vaso.name}
            <Button variant="ghost" size="sm" onClick={onRename} className="rounded-xl inline-flex gap-1">
              <Pencil className="h-4 w-4"/> Renombrar
            </Button>
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-rose-600 rounded-xl inline-flex gap-1">
            <Trash2 className="h-4 w-4"/> Eliminar
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6">
          {/* Visual del vaso */}
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-40 h-64 rounded-3xl border-4 border-slate-300 bg-white overflow-hidden">
              <div className="absolute left-0 right-0 border-t-4 border-rose-400/80" style={{ bottom: `${(vaso.threshold / vaso.capacity) * 100}%` }} />
              <div className={`absolute bottom-0 left-0 right-0 transition-all duration-700 ${inRedZone ? "bg-rose-200" : "bg-sky-200"}`} style={{ height: `${percent}%` }} />
            </div>
            <div className="text-center">
              <div className="text-3xl font-semibold">{Math.round(percent)}%</div>
              <div className="text-xs text-slate-600">Nivel: {vaso.level} / {vaso.capacity} gotas</div>
              {inRedZone && (
                <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-rose-100 px-3 py-1 text-rose-700">
                  <AlertTriangle className="h-4 w-4" /> Zona roja
                </div>
              )}
            </div>
          </div>

          {/* Controles */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="mb-2 text-sm text-slate-500">Añadir evento</div>
            <div className="grid grid-cols-1 gap-3">
              <Label htmlFor={`label-${vaso.id}`}>Etiqueta</Label>
              <Input id={`label-${vaso.id}`} placeholder="p.ej., discusión por tareas" value={label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
 />

              <div className="flex items-center justify-between">
                <Label>Gotas: {drops}</Label>
              </div>
              <Slider value={[drops]} min={1} max={15} step={1} onValueChange={(v: number[]) => setDrops(v[0])} />

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => onAddEvent(label, drops)} className="rounded-2xl">Añadir</Button>
                <Button variant="secondary" onClick={() => quickAdd("small")} className="rounded-2xl">+ pequeño (+2)</Button>
                <Button variant="secondary" onClick={() => quickAdd("medium")} className="rounded-2xl">+ mediano (+4)</Button>
                <Button variant="secondary" onClick={() => quickAdd("large")} className="rounded-2xl">+ grande (+8)</Button>
                <Button variant="ghost" onClick={onUndo} className="rounded-2xl inline-flex gap-2"><Undo2 className="h-4 w-4"/> Deshacer último</Button>
              </div>
            </div>
          </div>

          {/* Ajustes */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="mb-3 text-sm text-slate-500">Ajustes</div>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <Label>Capacidad (gotas)</Label>
                <div className="flex items-center gap-3">
                  <Slider value={[vaso.capacity]} min={20} max={300} step={5} onValueChange={(v: number[]) => onChange({ capacity: v[0], level: Math.min(v[0], vaso.level), threshold: Math.min(v[0], vaso.threshold) })} />
                  <span className="text-sm w-10 text-right">{vaso.capacity}</span>
                </div>
              </div>
              <div>
                <Label>Línea roja</Label>
                <div className="flex items-center gap-3">
                  <Slider value={[vaso.threshold]} min={0} max={vaso.capacity} step={1} onValueChange={(v: number[]) => onChange({ threshold: v[0] })} />
                  <span className="text-sm w-10 text-right">{vaso.threshold}</span>
                </div>
              </div>
              <div>
                <Label>Evaporación diaria</Label>
                <div className="flex items-center gap-3">
                  <Slider value={[vaso.evaporationPerDay]} min={0} max={10} step={1} onValueChange={(v: number[]) => onChange({ evaporationPerDay: v[0] })} />
                  <span className="text-sm w-10 text-right">{vaso.evaporationPerDay}</span>
                </div>
              </div>
              <div>
                <Label>Nivel manual</Label>
                <div className="flex items-center gap-3">
                  <Slider value={[vaso.level]} min={0} max={vaso.capacity} step={1} onValueChange={(v: number[]) => onChange({ level: v[0] })} />
                  <span className="text-sm w-10 text-right">{vaso.level}</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch id={`auto-${vaso.id}`} checked={vaso.autoDailyTick} onCheckedChange={(val) => onChange({ autoDailyTick: Boolean(val) })} />
                  <Label htmlFor={`auto-${vaso.id}`}>Evaporación automática</Label>
                </div>
                <Button variant="outline" onClick={() => onChange({ ...defaultVaso(vaso.name), id: vaso.id })} className="rounded-2xl inline-flex gap-2">
                  <RefreshCw className="h-4 w-4"/> Reset vaso
                </Button>
              </div>
            </div>
          </div>

          {/* Gráfico */}
          <div>
            <div className="mb-2 flex items-center gap-2 text-slate-600">
              <Flame className="h-4 w-4" /> Evolución (últimos meses)
            </div>
            <div className="h-56 w-full rounded-2xl border bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dateISO" tick={{ fontSize: 12 }} angle={0} height={30} tickMargin={8} />
                  <YAxis domain={[0, vaso.capacity]} allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
                  <Tooltip formatter={(value) => `${value} gotas`} labelFormatter={(l) => `Día ${l}`} />
                  <ReferenceLine y={vaso.threshold} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="level" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Eventos */}
          <div>
            <div className="mb-3 text-slate-600">Eventos recientes</div>
            {vaso.events.length === 0 ? (
              <div className="text-sm text-slate-500">Aún no has añadido eventos.</div>
            ) : (
              <div className="grid gap-2">
                {vaso.events.map((e) => (
                  <div key={e.id} className="rounded-xl border bg-white p-3 text-sm flex items-center justify-between">
                    <div>
                      <div className="font-medium">{e.label}</div>
                      <div className="text-slate-500">{e.dateISO}</div>
                    </div>
                    <div className="text-slate-700">+{e.drops} gotas</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
