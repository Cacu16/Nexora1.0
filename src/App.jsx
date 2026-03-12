import { startTransition, useDeferredValue, useEffect, useState } from "react";

const emptyClient = {
  id: "",
  nombre: "",
  estado: "Activo",
  tono: "",
  assistantName: "Fer",
  businessName: "",
  businessDescription: "",
  leadGoal: "",
  greeting: "",
  promptNotes: [""],
  planes: [
    {
      nombre: "Starter",
      setup: "",
      mensual: "",
      beneficios: [""],
    },
  ],
};

function createClientDraft() {
  return {
    ...emptyClient,
    id: `cliente-${Date.now()}`,
    nombre: "Nuevo cliente",
    businessName: "Nuevo cliente",
    tono: "Profesional y cercano",
    businessDescription: "Describe el negocio, su propuesta de valor y el tipo de clientes que atiende.",
    leadGoal: "Definir si el prospecto esta listo para contratar y pedir sus datos.",
    greeting: "Estoy para ayudarte con informacion sobre nuestros planes y automatizaciones.",
    promptNotes: [
      "Nunca digas que sos una IA.",
      "Habla de forma breve y directa.",
      "Si hay intencion de compra, pedi datos de contacto.",
    ],
    planes: [
      {
        nombre: "Starter",
        setup: "$0",
        mensual: "$0",
        beneficios: ["Define el primer beneficio del plan"],
      },
    ],
  };
}

function buildPromptPreview(client) {
  const notes = client.promptNotes.filter(Boolean);
  const planes = client.planes
    .map((plan) => {
      const benefits = plan.beneficios.filter(Boolean);
      const benefitLines = benefits.length
        ? benefits.map((item) => `- ${item}`).join("\n")
        : "- Sin beneficios cargados";

      return `${plan.nombre.toUpperCase()}\nSetup: ${plan.setup || "Sin definir"}\nMensual: ${
        plan.mensual || "Sin definir"
      }\n${benefitLines}`;
    })
    .join("\n\n");

  return `Asistente: ${client.assistantName || "Fer"}\nMarca: ${
    client.businessName || client.nombre || "Cliente"
  }\nTono: ${client.tono || "Sin definir"}\n\nDescripcion:\n${
    client.businessDescription || "Sin descripcion"
  }\n\nObjetivo del lead:\n${client.leadGoal || "Sin objetivo"}\n\nSaludo:\n${
    client.greeting || "Sin saludo"
  }\n\nReglas:\n${
    notes.length ? notes.map((item) => `- ${item}`).join("\n") : "- Sin reglas"
  }\n\nPlanes:\n${planes || "Sin planes"}`;
}

function App() {
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(createClientDraft());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    loadClients();
  }, []);

  useEffect(() => {
    if (!statusMessage) {
      return undefined;
    }

    const timer = window.setTimeout(() => setStatusMessage(""), 2500);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  async function loadClients(nextSelectedId) {
    setLoading(true);

    try {
      const response = await fetch("/api/clientes");
      const data = await response.json();
      const list = Array.isArray(data.clientes) ? data.clientes : [];

      startTransition(() => {
        setClients(list);

        const preferredId = nextSelectedId || selectedId || list[0]?.id || "";
        const current =
          list.find((client) => client.id === preferredId) ||
          list[0] ||
          createClientDraft();

        setSelectedId(current.id || "");
        setDraft(structuredClone(current));
      });
    } catch (error) {
      setStatusMessage("No se pudo cargar la configuracion.");
    } finally {
      setLoading(false);
    }
  }

  function selectClient(client) {
    setSelectedId(client.id);
    setDraft(structuredClone(client));
  }

  function updateField(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      businessName:
        field === "nombre" && (!current.businessName || current.businessName === current.nombre)
          ? value
          : current.businessName,
    }));
  }

  function updatePromptNote(index, value) {
    setDraft((current) => ({
      ...current,
      promptNotes: current.promptNotes.map((item, itemIndex) =>
        itemIndex === index ? value : item
      ),
    }));
  }

  function addPromptNote() {
    setDraft((current) => ({
      ...current,
      promptNotes: [...current.promptNotes, ""],
    }));
  }

  function removePromptNote(index) {
    setDraft((current) => ({
      ...current,
      promptNotes:
        current.promptNotes.length === 1
          ? [""]
          : current.promptNotes.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function updatePlan(index, field, value) {
    setDraft((current) => ({
      ...current,
      planes: current.planes.map((plan, planIndex) =>
        planIndex === index ? { ...plan, [field]: value } : plan
      ),
    }));
  }

  function addPlan() {
    setDraft((current) => ({
      ...current,
      planes: [
        ...current.planes,
        { nombre: `Plan ${current.planes.length + 1}`, setup: "", mensual: "", beneficios: [""] },
      ],
    }));
  }

  function removePlan(index) {
    setDraft((current) => ({
      ...current,
      planes:
        current.planes.length === 1
          ? current.planes
          : current.planes.filter((_, planIndex) => planIndex !== index),
    }));
  }

  function updateBenefit(planIndex, benefitIndex, value) {
    setDraft((current) => ({
      ...current,
      planes: current.planes.map((plan, index) =>
        index === planIndex
          ? {
              ...plan,
              beneficios: plan.beneficios.map((item, idx) => (idx === benefitIndex ? value : item)),
            }
          : plan
      ),
    }));
  }

  function addBenefit(planIndex) {
    setDraft((current) => ({
      ...current,
      planes: current.planes.map((plan, index) =>
        index === planIndex
          ? {
              ...plan,
              beneficios: [...plan.beneficios, ""],
            }
          : plan
      ),
    }));
  }

  function removeBenefit(planIndex, benefitIndex) {
    setDraft((current) => ({
      ...current,
      planes: current.planes.map((plan, index) =>
        index === planIndex
          ? {
              ...plan,
              beneficios:
                plan.beneficios.length === 1
                  ? [""]
                  : plan.beneficios.filter((_, idx) => idx !== benefitIndex),
            }
          : plan
      ),
    }));
  }

  async function saveDraft() {
    setSaving(true);

    try {
      const editingExistingClient = clients.some((client) => client.id === selectedId);
      const method = editingExistingClient ? "PUT" : "POST";
      const url = editingExistingClient ? `/api/clientes/${selectedId}` : "/api/clientes";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });

      if (!response.ok) {
        throw new Error("save_failed");
      }

      const data = await response.json();
      setStatusMessage("Configuracion guardada.");
      await loadClients(data.cliente.id);
    } catch (error) {
      setStatusMessage("No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteClient() {
    if (!selectedId) {
      return;
    }

    const confirmed = window.confirm(
      `Se va a eliminar la configuracion de ${draft.nombre || selectedId}.`
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/clientes/${selectedId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("delete_failed");
      }

      setStatusMessage("Cliente eliminado.");
      setSelectedId("");
      await loadClients("");
    } catch (error) {
      setStatusMessage("No se pudo eliminar.");
    }
  }

  function createClient() {
    const nextClient = createClientDraft();
    setSelectedId(nextClient.id);
    setDraft(nextClient);
  }

  const filteredClients = clients.filter((client) => {
    const term = deferredSearch.trim().toLowerCase();

    if (!term) {
      return true;
    }

    return [client.nombre, client.id, client.businessDescription]
      .join(" ")
      .toLowerCase()
      .includes(term);
  });

  return (
    <div className="shell">
      <div className="backdrop backdrop-left" />
      <div className="backdrop backdrop-right" />

      <header className="topbar">
        <div>
          <span className="eyebrow">Nexora Control Center</span>
          <h1>Configuracion de clientes en tiempo real</h1>
          <p>
            Administra tono, nombre del asistente, planes y reglas de cada cliente desde un solo
            panel.
          </p>
        </div>

        <div className="topbar-actions">
          <button className="secondary-button" onClick={createClient}>
            Nuevo cliente
          </button>
          <button className="primary-button" onClick={saveDraft} disabled={saving}>
            {saving ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar card">
          <div className="sidebar-head">
            <div>
              <span className="section-kicker">Clientes</span>
              <h2>Base activa</h2>
            </div>
            <span className="pill">{clients.length}</span>
          </div>

          <label className="field">
            <span>Buscar</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nombre, id o descripcion"
            />
          </label>

          <div className="client-list">
            {loading ? (
              <div className="empty-state">Cargando clientes...</div>
            ) : filteredClients.length ? (
              filteredClients.map((client) => (
                <button
                  key={client.id}
                  className={`client-card ${selectedId === client.id ? "active" : ""}`}
                  onClick={() => selectClient(client)}
                >
                  <div>
                    <strong>{client.nombre}</strong>
                    <span>{client.id}</span>
                  </div>
                  <span className={`status-tag ${client.estado === "Activo" ? "online" : "draft"}`}>
                    {client.estado}
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">No hay resultados para esa busqueda.</div>
            )}
          </div>
        </aside>

        <section className="editor">
          <div className="editor-grid">
            <article className="card form-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Perfil</span>
                  <h2>Datos principales</h2>
                </div>
                {statusMessage ? <span className="save-badge">{statusMessage}</span> : null}
              </div>

              <div className="form-grid">
                <label className="field">
                  <span>Phone Number ID</span>
                  <input value={draft.id} onChange={(event) => updateField("id", event.target.value)} />
                </label>
                <label className="field">
                  <span>Estado</span>
                  <select
                    value={draft.estado}
                    onChange={(event) => updateField("estado", event.target.value)}
                  >
                    <option>Activo</option>
                    <option>Borrador</option>
                    <option>Pausado</option>
                  </select>
                </label>
                <label className="field">
                  <span>Nombre comercial</span>
                  <input
                    value={draft.nombre}
                    onChange={(event) => updateField("nombre", event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Nombre del asistente</span>
                  <input
                    value={draft.assistantName}
                    onChange={(event) => updateField("assistantName", event.target.value)}
                  />
                </label>
                <label className="field field-full">
                  <span>Tono</span>
                  <input value={draft.tono} onChange={(event) => updateField("tono", event.target.value)} />
                </label>
                <label className="field field-full">
                  <span>Descripcion del negocio</span>
                  <textarea
                    rows="4"
                    value={draft.businessDescription}
                    onChange={(event) => updateField("businessDescription", event.target.value)}
                  />
                </label>
                <label className="field field-full">
                  <span>Objetivo del lead</span>
                  <textarea
                    rows="3"
                    value={draft.leadGoal}
                    onChange={(event) => updateField("leadGoal", event.target.value)}
                  />
                </label>
                <label className="field field-full">
                  <span>Mensaje de presentacion</span>
                  <textarea
                    rows="3"
                    value={draft.greeting}
                    onChange={(event) => updateField("greeting", event.target.value)}
                  />
                </label>
              </div>
            </article>

            <article className="card form-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Reglas</span>
                  <h2>Instrucciones del asistente</h2>
                </div>
                <button className="ghost-button" onClick={addPromptNote}>
                  Agregar regla
                </button>
              </div>

              <div className="stack">
                {draft.promptNotes.map((note, index) => (
                  <div className="inline-editor" key={`${index}-${note}`}>
                    <textarea
                      rows="2"
                      value={note}
                      onChange={(event) => updatePromptNote(index, event.target.value)}
                    />
                    <button className="icon-button" onClick={() => removePromptNote(index)}>
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            </article>

            <article className="card form-card plans-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Planes</span>
                  <h2>Oferta comercial</h2>
                </div>
                <button className="ghost-button" onClick={addPlan}>
                  Agregar plan
                </button>
              </div>

              <div className="plans-grid">
                {draft.planes.map((plan, planIndex) => (
                  <section className="plan-card" key={`${plan.nombre}-${planIndex}`}>
                    <div className="plan-top">
                      <input
                        className="plan-title-input"
                        value={plan.nombre}
                        onChange={(event) => updatePlan(planIndex, "nombre", event.target.value)}
                      />
                      <button className="icon-button" onClick={() => removePlan(planIndex)}>
                        Eliminar
                      </button>
                    </div>

                    <div className="form-grid compact-grid">
                      <label className="field">
                        <span>Setup</span>
                        <input
                          value={plan.setup}
                          onChange={(event) => updatePlan(planIndex, "setup", event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>Mensual</span>
                        <input
                          value={plan.mensual}
                          onChange={(event) => updatePlan(planIndex, "mensual", event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="benefits">
                      {plan.beneficios.map((benefit, benefitIndex) => (
                        <div className="inline-editor benefit-row" key={`${benefitIndex}-${benefit}`}>
                          <input
                            value={benefit}
                            onChange={(event) =>
                              updateBenefit(planIndex, benefitIndex, event.target.value)
                            }
                            placeholder="Beneficio del plan"
                          />
                          <button
                            className="icon-button"
                            onClick={() => removeBenefit(planIndex, benefitIndex)}
                          >
                            Quitar
                          </button>
                        </div>
                      ))}
                    </div>

                    <button className="ghost-button" onClick={() => addBenefit(planIndex)}>
                      Agregar beneficio
                    </button>
                  </section>
                ))}
              </div>
            </article>
          </div>
        </section>

        <aside className="preview-column">
          <article className="card preview-card">
            <div className="section-header">
              <div>
                <span className="section-kicker">Vista previa</span>
                <h2>Prompt operativo</h2>
              </div>
              <span className="pill accent">{draft.assistantName || "Fer"}</span>
            </div>

            <pre>{buildPromptPreview(draft)}</pre>
          </article>

          <article className="card metrics-card">
            <span className="section-kicker">Resumen</span>
            <div className="metric-row">
              <div>
                <strong>{draft.planes.length}</strong>
                <span>Planes activos</span>
              </div>
              <div>
                <strong>{draft.promptNotes.filter(Boolean).length}</strong>
                <span>Reglas cargadas</span>
              </div>
            </div>
            <button
              className="danger-button"
              onClick={deleteClient}
              disabled={!clients.some((client) => client.id === selectedId)}
            >
              Eliminar cliente
            </button>
          </article>
        </aside>
      </main>
    </div>
  );
}

export default App;
