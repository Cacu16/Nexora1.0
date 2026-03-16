import { startTransition, useDeferredValue, useEffect, useState } from "react";

const defaultConfig = {
  mainPrompt: [
    "Sos Fer, el asistente comercial de Nexora. Hablás como una persona real del equipo, con calidez, claridad y seguridad. Tu objetivo es acompañar al cliente, entender su necesidad, generar confianza y llevar la conversación hacia una acción concreta: responder, cotizar, reservar, agendar o dejar sus datos.",
    "",
    "Usá español rioplatense natural.",
    "Preferí expresiones como \"acá\", \"decime\", \"contame\", \"dale\", \"buenísimo\", \"si querés\".",
    "No uses formas neutras o demasiado formales como \"aquí\", \"indíqueme\", \"podría\", \"de acuerdo\".",
    "",
    "Identidad y estilo:",
    "- Siempre hablás en primera persona como Fer.",
    "- Tuteás al cliente de forma natural, cercana y profesional.",
    "- Sonás humano, ágil y conversacional; nunca robótico, frío ni genérico.",
    "- Escribís como en WhatsApp: claro, breve, amable y directo.",
    "- No usás tecnicismos innecesarios.",
    "- No saturás con información; das contexto justo y útil.",
    "- No repetís frases ni saludos de forma mecánica.",
    "",
    "Objetivo comercial:",
    "- Detectá rápido qué quiere el cliente, qué problema tiene, qué duda lo frena y qué tan listo está para avanzar.",
    "- Guiás la conversación para que el cliente llegue a una decisión con menos fricción.",
    "- Si ves interés real, avanzá con seguridad hacia el cierre o la captura de datos.",
    "- Si el cliente duda, no presiones: aclará, simplificá y reducí incertidumbre.",
    "",
    "Psicología de venta aplicada de forma ética:",
    "- Generá confianza primero, venta después.",
    "- Hacé preguntas cortas y útiles para que el cliente se sienta entendido.",
    "- Resaltá beneficios concretos antes que características.",
    "- Conectá la solución con el resultado que el cliente quiere lograr.",
    "- Usá prueba social solo si está disponible y es real.",
    "- Usá urgencia o escasez solo si es real.",
    "- Presentá opciones de forma simple para evitar confusión.",
    "- Reducí fricción: explicá fácil, proponé el siguiente paso y pedí una sola acción a la vez.",
    "- Reforzá seguridad, claridad y acompañamiento.",
    "- Nunca manipules, nunca mientas, nunca inventes.",
    "",
    "Comportamiento conversacional:",
    "- Respondé con empatía y naturalidad.",
    "- Si el cliente llega frío, primero conversá y entendé.",
    "- Si el cliente llega con alta intención, andá más rápido al punto.",
    "- Si pregunta precio, respondé claro y luego ayudalo a elegir la opción más conveniente.",
    "- Si duda, respondé la objeción y volvé a orientar la conversación.",
    "- Si no entiende, reformulá más simple.",
    "- Si el cliente da señales de compra, pedí los datos necesarios para avanzar.",
    "- Hacé una pregunta por vez cuando necesites destrabar la conversación.",
    "- Cerrá los mensajes con una dirección clara cuando convenga: elegir opción, confirmar interés, dejar datos o avanzar al siguiente paso.",
    "",
    "Límites y calidad:",
    "- Nunca inventes precios, promociones, stock, tiempos, resultados, testimonios ni políticas.",
    "- Nunca contradigas la información del cliente activo.",
    "- Si falta información, decilo con naturalidad y redirigí.",
    "- Nunca digas que sos una IA.",
    "- Nunca digas que sos un asistente genérico.",
    "- Mantené siempre coherencia con el negocio, el tono y los planes configurados para ese cliente.",
    "",
    "Forma ideal de responder:",
    "- Entiende",
    "- Orienta",
    "- Resuelve",
    "- Acerca al cierre",
    "",
    "Cada mensaje debe sentirse humano, útil y comercialmente inteligente.",
  ].join("\n"),
  openaiApiKey: "",
  whatsappToken: "",
  webhookVerifyToken: "",
};

const defaultClientRuntime = {
  phoneNumberId: "",
  phoneNumberIdConfigured: false,
  openaiConfigured: false,
  whatsappConfigured: false,
  leadEmailConfigured: true,
  ready: false,
};

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
  leadEmail: "",
  openaiApiKey: "",
  whatsappToken: "",
  mainPromptOverride: "",
  clientPrompt: "",
  promptNotes: [""],
  planes: [
    {
      nombre: "Starter",
      setup: "",
      mensual: "",
      beneficios: [""],
    },
  ],
  runtime: defaultClientRuntime,
};

function isValidPhoneNumberId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function getClientRuntime(client, config = defaultConfig) {
  const runtime = client?.runtime && typeof client.runtime === "object" ? client.runtime : {};
  const phoneNumberId = String(runtime.phoneNumberId || client?.id || "").trim();
  const phoneNumberIdConfigured =
    "phoneNumberIdConfigured" in runtime
      ? Boolean(runtime.phoneNumberIdConfigured)
      : isValidPhoneNumberId(phoneNumberId);
  const openaiConfigured =
    "openaiConfigured" in runtime
      ? Boolean(runtime.openaiConfigured)
      : Boolean(String(client?.openaiApiKey || config?.openaiApiKey || "").trim());
  const whatsappConfigured =
    "whatsappConfigured" in runtime
      ? Boolean(runtime.whatsappConfigured)
      : Boolean(String(client?.whatsappToken || config?.whatsappToken || "").trim());
  const leadEmailConfigured =
    "leadEmailConfigured" in runtime
      ? Boolean(runtime.leadEmailConfigured)
      : true;

  return {
    ...defaultClientRuntime,
    ...runtime,
    phoneNumberId,
    phoneNumberIdConfigured,
    openaiConfigured,
    whatsappConfigured,
    leadEmailConfigured,
    ready: phoneNumberIdConfigured && openaiConfigured && whatsappConfigured,
  };
}

function decorateClient(client, config = defaultConfig) {
  return {
    ...client,
    runtime: getClientRuntime(client, config),
  };
}

function getClientIssues(runtime) {
  const issues = [];

  if (!runtime.phoneNumberIdConfigured) {
    issues.push("Falta el Phone Number ID numerico real de Meta para enrutar el webhook.");
  }

  if (!runtime.openaiConfigured) {
    issues.push("Falta una OpenAI API Key para este cliente o a nivel global.");
  }

  if (!runtime.whatsappConfigured) {
    issues.push("Falta el WhatsApp Token de Meta para este cliente o a nivel global.");
  }

  return issues;
}

function buildClientMainPrompt(basePrompt, businessName) {
  const source = String(basePrompt || defaultConfig.mainPrompt || "").trim();
  const business = String(businessName || "Cliente").trim();
  return source.replace(/\bNexora\b/gi, business);
}

function createClientDraft(baseConfig = defaultConfig) {
  return decorateClient({
    ...emptyClient,
    id: `cliente-${Date.now()}`,
    nombre: "Nuevo cliente",
    businessName: "Nuevo cliente",
    tono: "Profesional y cercano",
    businessDescription: "Describe el negocio, su propuesta de valor y el tipo de clientes que atiende.",
    leadGoal: "Definir si el prospecto esta listo para contratar y pedir sus datos.",
    greeting: "Estoy para ayudarte con informacion sobre nuestros planes y automatizaciones.",
    leadEmail: "",
    openaiApiKey: "",
    whatsappToken: "",
    mainPromptOverride: buildClientMainPrompt(baseConfig.mainPrompt, "Nuevo cliente"),
    clientPrompt:
      "Habla como parte del negocio. Usa el contexto comercial del cliente y lleva la conversacion hacia una accion concreta.",
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
  }, baseConfig);
}

function buildPromptPreview(client, config) {
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

  const effectiveMainPrompt = client.mainPromptOverride || config.mainPrompt || "Sin prompt principal";

  return `Prompt principal efectivo:\n${effectiveMainPrompt}\n\nAsistente: ${
    client.assistantName || "Fer"
  }\nMarca: ${
    client.businessName || client.nombre || "Cliente"
  }\nTono: ${client.tono || "Sin definir"}\n\nDescripcion:\n${
    client.businessDescription || "Sin descripcion"
  }\n\nObjetivo del lead:\n${client.leadGoal || "Sin objetivo"}\n\nSaludo:\n${
    client.greeting || "Sin saludo"
  }\n\nEmail de leads:\n${
    client.leadEmail || "Sin email definido"
  }\n\nInstrucciones adicionales del cliente:\n${
    client.clientPrompt || "Sin instrucciones extra"
  }\n\nReglas:\n${
    notes.length ? notes.map((item) => `- ${item}`).join("\n") : "- Sin reglas"
  }\n\nPlanes:\n${planes || "Sin planes"}`;
}

function App() {
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(createClientDraft());
  const [config, setConfig] = useState(defaultConfig);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [healthChecks, setHealthChecks] = useState({
    openaiConfigured: false,
    whatsappConfigured: false,
    spreadsheetConfigured: false,
    resendConfigured: false,
    webhookVerifyTokenConfigured: true,
  });
  const deferredSearch = useDeferredValue(search);
  const draftRuntime = getClientRuntime(draft, config);
  const normalizedDraftId = String(draft.id || "").trim();
  const duplicatePhoneNumberId = clients.some(
    (client) => client.id === normalizedDraftId && client.id !== selectedId
  );
  const draftIssues = [
    ...getClientIssues(draftRuntime),
    ...(duplicatePhoneNumberId
      ? ["Ese Phone Number ID ya pertenece a otro cliente. Tiene que ser unico."]
      : []),
  ];

  function syncClient(client, nextConfig = config) {
    return decorateClient(client, nextConfig);
  }

  function updateDraft(updater) {
    setDraft((current) => syncClient(typeof updater === "function" ? updater(current) : updater));
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!statusMessage) {
      return undefined;
    }

    const timer = window.setTimeout(() => setStatusMessage(""), 2500);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  async function loadData(nextSelectedId) {
    setLoading(true);

    try {
      const [clientsResponse, configResponse] = await Promise.all([
        fetch("/api/clientes"),
        fetch("/api/config"),
      ]);

      if (!clientsResponse.ok || !configResponse.ok) {
        throw new Error("load_failed");
      }

      const clientsData = await clientsResponse.json();
      const configData = await configResponse.json();
      const nextConfig =
        configData?.config && typeof configData.config === "object"
          ? { ...defaultConfig, ...configData.config }
          : defaultConfig;
      let nextChecks = healthChecks;
      const list = Array.isArray(clientsData.clientes)
        ? clientsData.clientes.map((client) => syncClient(client, nextConfig))
        : [];

      try {
        const healthResponse = await fetch("/api/health");

        if (healthResponse.ok) {
          const healthData = await healthResponse.json();
          nextChecks =
            healthData?.checks && typeof healthData.checks === "object"
              ? healthData.checks
              : nextChecks;
        }
      } catch {}

      startTransition(() => {
        setClients(list);
        setConfig(nextConfig);
        setHealthChecks(nextChecks);

        const preferredId = nextSelectedId || selectedId || list[0]?.id || "";
        const current =
          list.find((client) => client.id === preferredId) ||
          list[0] ||
          createClientDraft(nextConfig);

        setSelectedId(current.id || "");
        setDraft(structuredClone(syncClient(current, nextConfig)));
      });
    } catch (error) {
      setStatusMessage("No se pudo cargar la configuracion.");
    } finally {
      setLoading(false);
    }
  }

  function selectClient(client) {
    setShowGlobalSettings(false);
    setSelectedId(client.id);
    setDraft(structuredClone(syncClient(client)));
  }

  function updateField(field, value) {
    updateDraft((current) => ({
      ...current,
      [field]: value,
      businessName:
        field === "nombre" && (!current.businessName || current.businessName === current.nombre)
          ? value
          : current.businessName,
    }));
  }

  function applyBasePromptToDraft() {
    updateDraft((current) => ({
      ...current,
      mainPromptOverride: buildClientMainPrompt(
        config.mainPrompt,
        current.businessName || current.nombre || "Cliente"
      ),
    }));
  }

  function updateConfigField(field, value) {
    const nextConfig = {
      ...config,
      [field]: value,
    };

    setConfig(nextConfig);
    setDraft((current) => syncClient(current, nextConfig));
  }

  function updatePromptNote(index, value) {
    updateDraft((current) => ({
      ...current,
      promptNotes: current.promptNotes.map((item, itemIndex) =>
        itemIndex === index ? value : item
      ),
    }));
  }

  function addPromptNote() {
    updateDraft((current) => ({
      ...current,
      promptNotes: [...current.promptNotes, ""],
    }));
  }

  function removePromptNote(index) {
    updateDraft((current) => ({
      ...current,
      promptNotes:
        current.promptNotes.length === 1
          ? [""]
          : current.promptNotes.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function updatePlan(index, field, value) {
    updateDraft((current) => ({
      ...current,
      planes: current.planes.map((plan, planIndex) =>
        planIndex === index ? { ...plan, [field]: value } : plan
      ),
    }));
  }

  function addPlan() {
    updateDraft((current) => ({
      ...current,
      planes: [
        ...current.planes,
        { nombre: `Plan ${current.planes.length + 1}`, setup: "", mensual: "", beneficios: [""] },
      ],
    }));
  }

  function removePlan(index) {
    updateDraft((current) => ({
      ...current,
      planes:
        current.planes.length === 1
          ? current.planes
          : current.planes.filter((_, planIndex) => planIndex !== index),
    }));
  }

  function updateBenefit(planIndex, benefitIndex, value) {
    updateDraft((current) => ({
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
    updateDraft((current) => ({
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
    updateDraft((current) => ({
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
    if (!normalizedDraftId) {
      setStatusMessage("Cada cliente necesita un Phone Number ID para poder guardarse.");
      return;
    }

    if (duplicatePhoneNumberId) {
      setStatusMessage("Ese Phone Number ID ya esta asignado a otro cliente.");
      return;
    }

    setSaving(true);

    try {
      const editingExistingClient = clients.some((client) => client.id === selectedId);
      const method = editingExistingClient ? "PUT" : "POST";
      const url = editingExistingClient ? `/api/clientes/${selectedId}` : "/api/clientes";

      const clientResponse = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });

      if (!clientResponse.ok) {
        const errorData = await clientResponse.json().catch(() => ({}));
        throw new Error(errorData.error || "save_failed");
      }

      const clientData = await clientResponse.json();
      setShowGlobalSettings(false);
      setStatusMessage("Cliente guardado.");
      await loadData(clientData.cliente.id);
    } catch (error) {
      setStatusMessage(error.message === "save_failed" ? "No se pudo guardar." : error.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveGlobalConfig() {
    setSavingGlobal(true);

    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "save_config_failed");
      }

      const configData = await response.json();
      setConfig({
        ...defaultConfig,
        ...(configData.config || {}),
      });
      setShowGlobalSettings(false);
      setStatusMessage("Configuracion global guardada.");
      await loadData(selectedId);
    } catch (error) {
      setStatusMessage(
        error.message === "save_config_failed"
          ? "No se pudo guardar la configuracion global."
          : error.message
      );
    } finally {
      setSavingGlobal(false);
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
      await loadData("");
    } catch (error) {
      setStatusMessage("No se pudo eliminar.");
    }
  }

  function createClient() {
    const nextClient = createClientDraft(config);
    setShowGlobalSettings(false);
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
          <button className="ghost-button" onClick={() => setShowGlobalSettings(true)}>
            Webhook global
          </button>
          <button className="secondary-button" onClick={createClient}>
            Nuevo cliente
          </button>
          <button
            className="primary-button"
            onClick={saveDraft}
            disabled={saving || !normalizedDraftId || duplicatePhoneNumberId}
          >
            {saving ? "Guardando..." : "Guardar cliente"}
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
                  <div className="client-meta">
                    <strong>{client.nombre}</strong>
                    <span>{client.id}</span>
                    <span>{client.estado}</span>
                  </div>
                  <span className={`status-tag ${client.runtime?.ready ? "online" : "draft"}`}>
                    {client.runtime?.ready ? "Conectado" : "Incompleto"}
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
            <article className="card form-card info-card">
              <span className="section-kicker">Importante</span>
              <p>
                Cada cliente mantiene su propio guardado, sus credenciales y su historial aislado.
              </p>
              <p>
                Nexora solo puede responder por separado si cada cliente tiene su `Phone Number ID`
                real de Meta y un token valido por cliente o global.
              </p>
            </article>

            <article className="card form-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Estado operativo</span>
                  <h2>Conexion del cliente</h2>
                </div>
                <span className={`pill ${draftIssues.length ? "" : "accent"}`}>
                  {draftIssues.length ? "Faltan datos" : "Listo para responder"}
                </span>
              </div>

              <div className="status-checks">
                <div className={`status-summary ${draftRuntime.phoneNumberIdConfigured ? "ready" : "warn"}`}>
                  Phone Number ID {draftRuntime.phoneNumberIdConfigured ? "ok" : "faltante"}
                </div>
                <div className={`status-summary ${draftRuntime.openaiConfigured ? "ready" : "warn"}`}>
                  OpenAI {draftRuntime.openaiConfigured ? "ok" : "faltante"}
                </div>
                <div className={`status-summary ${draftRuntime.whatsappConfigured ? "ready" : "warn"}`}>
                  WhatsApp {draftRuntime.whatsappConfigured ? "ok" : "faltante"}
                </div>
              </div>

              <div className="stack">
                {draftIssues.length ? (
                  draftIssues.map((issue) => (
                    <small className="field-hint field-error" key={issue}>
                      {issue}
                    </small>
                  ))
                ) : (
                  <small className="field-hint field-success">
                    Este cliente ya tiene lo necesario para responder desde su webhook sin mezclar
                    conversaciones con otros.
                  </small>
                )}
              </div>
            </article>

            <article className="card form-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Cliente activo</span>
                  <h2>Credenciales del cliente</h2>
                </div>
              </div>

              <div className="form-grid">
                <label className="field field-full">
                  <span>OpenAI API Key del cliente</span>
                  <input
                    type="password"
                    value={draft.openaiApiKey || ""}
                    onChange={(event) => updateField("openaiApiKey", event.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                  />
                  <small className="field-hint">
                    Va por cliente. Si la dejas vacia, usa la API key global de Nexora.
                  </small>
                </label>
                <label className="field field-full">
                  <span>WhatsApp Token del cliente</span>
                  <input
                    type="password"
                    value={draft.whatsappToken || ""}
                    onChange={(event) => updateField("whatsappToken", event.target.value)}
                    placeholder="EAAG..."
                    autoComplete="off"
                  />
                  <small className="field-hint">
                    Pega aca el token `EAAG...` o `EAAX...` de Meta para este cliente. No va en
                    `Webhook global`.
                  </small>
                  <small className="field-hint">
                    Si arranca con `nexora_`, esta mal pegado: eso corresponde al webhook global.
                  </small>
                </label>
              </div>
            </article>

            <article className="card form-card">
              <div className="section-header">
                <div>
                  <span className="section-kicker">Cliente activo</span>
                  <h2>Prompt principal del cliente</h2>
                </div>
                <button className="ghost-button" onClick={applyBasePromptToDraft}>
                  Cargar base Nexora
                </button>
              </div>

              <div className="stack">
                <label className="field">
                  <span>Prompt principal de este cliente</span>
                  <textarea
                    rows="10"
                    value={draft.mainPromptOverride || ""}
                    onChange={(event) => updateField("mainPromptOverride", event.target.value)}
                  />
                  <small className="field-hint">
                    Se guarda solo en este cliente. Si lo dejas vacio, usa el prompt global de
                    Nexora.
                  </small>
                </label>
              </div>
            </article>

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
                  <span>Phone Number ID de Meta</span>
                  <input value={draft.id} onChange={(event) => updateField("id", event.target.value)} />
                  <small className="field-hint">
                    Tiene que ser el `phone_number_id` numerico real de este cliente. No puede
                    repetirse.
                  </small>
                  {duplicatePhoneNumberId ? (
                    <small className="field-hint field-error">
                      Ese Phone Number ID ya esta asignado a otro cliente.
                    </small>
                  ) : null}
                  {!draftRuntime.phoneNumberIdConfigured ? (
                    <small className="field-hint field-error">
                      Mientras siga como `cliente-...` o tenga letras, este cliente no va a recibir
                      mensajes del webhook.
                    </small>
                  ) : null}
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
                <label className="field field-full">
                  <span>Email de leads</span>
                  <input
                    type="email"
                    value={draft.leadEmail || ""}
                    onChange={(event) => updateField("leadEmail", event.target.value)}
                    placeholder="leads@cliente.com"
                  />
                  <small className="field-hint">
                    Si lo dejas vacio, los leads se envian al correo principal de Nexora.
                  </small>
                </label>
                <label className="field field-full">
                  <span>Instrucciones adicionales del cliente</span>
                  <textarea
                    rows="5"
                    value={draft.clientPrompt}
                    onChange={(event) => updateField("clientPrompt", event.target.value)}
                  />
                  <small className="field-hint">
                    Este bloque complementa el prompt principal de este cliente.
                  </small>
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

            <pre>{buildPromptPreview(draft, config)}</pre>
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

      {showGlobalSettings ? (
        <div className="modal-overlay" onClick={() => setShowGlobalSettings(false)}>
          <div className="modal-card card" onClick={(event) => event.stopPropagation()}>
            <div className="section-header">
              <div>
                <span className="section-kicker">Global</span>
                <h2>Webhook global de Nexora</h2>
              </div>
              <button className="ghost-button" onClick={() => setShowGlobalSettings(false)}>
                Cerrar
              </button>
            </div>

            <div className="form-grid">
              <label className="field field-full">
                <span>Webhook Verify Token global</span>
                <input
                  value={config.webhookVerifyToken}
                  onChange={(event) => updateConfigField("webhookVerifyToken", event.target.value)}
                  placeholder="nexora_2026_secure"
                  autoComplete="off"
                />
                <small className="field-hint">
                  Tiene que coincidir exactamente con el token configurado en Meta. No pegues aca
                  el token `EAAG...` de WhatsApp.
                </small>
                <small className="field-hint">
                  Este campo suele verse como `nexora_2026_secure`, no como `EAAG...`.
                </small>
              </label>
            </div>

            <div className="stack">
              <small className="field-hint">
                Estado runtime: OpenAI {healthChecks.openaiConfigured ? "ok" : "faltante"} |
                WhatsApp {healthChecks.whatsappConfigured ? "ok" : "faltante"} | Verify token{" "}
                {healthChecks.webhookVerifyTokenConfigured ? "ok" : "faltante"}
              </small>
              <small className="field-hint">
                Este modal ahora se usa solo para el `Webhook Verify Token` global de Nexora.
              </small>
            </div>

            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => setShowGlobalSettings(false)}>
                Cancelar
              </button>
              <button className="primary-button" onClick={saveGlobalConfig} disabled={savingGlobal}>
                {savingGlobal ? "Guardando..." : "Guardar Nexora"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
