import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, apiJson, ApiError } from "../api";
import { searchSkus } from "../skuSearch";

/**
 * The Model picker (ticket 07): the one device-model selection control, the
 * model-side twin of SkuPicker. The fuzzy ranking is NOT copied — it calls
 * the same `searchSkus` ranker over the models catalog (GET /api/models), so
 * substring → all-words → word-prefix → subsequence and the codepoint/id
 * tie-breaks behave identically for models and SKUs (one search
 * implementation, two consumers).
 *
 * Ticket 07: with `allowCreate`, typing a name that matches nothing offers
 * "add <name>"; creation POSTs to the existing /api/models endpoint (the
 * server records `model.created` and dedupes case-insensitively). The offer
 * appears only when the search finds NOTHING — its job is to fill a gap, not
 * to sit under matching results inviting a near-duplicate.
 *
 * The 409 duplicate path is loud AND resolving: because the server dedupes
 * case-insensitively, a 409 means the model exists, so the picker refetches
 * the catalog from the server (the props copy may be stale — another tech
 * may have created the model after this page loaded), selects the matching
 * existing row, and shows the server's message — it never silently re-tries
 * with a different name nor leaves the tech on a dead end. A 409 whose
 * refetched catalog has no matching name is a server/client inconsistency
 * and stays on screen as an error.
 *
 * Keyboard: ArrowUp/ArrowDown move the highlight, Enter selects it, Escape
 * closes the list. Enter while the list is open never submits the
 * surrounding form (the add-device modal is a form). Clicking a row selects
 * it too.
 */

export interface ModelPickerOption {
  id: number;
  name: string;
}

export function ModelPicker({
  models,
  value,
  onChange,
  onCreated,
  placeholder = "Type to search models…",
  autoFocus = false,
  allowCreate = true,
}: {
  /** The full catalog from GET /api/models. */
  models: ModelPickerOption[];
  /** Selected model id as a string, "" when nothing is picked. */
  value: string;
  onChange: (modelId: string) => void;
  /**
   * Called with a model the caller's catalog may be missing: the freshly
   * created one, or the existing row selected after a 409. The caller MUST
   * merge it into its catalog list (by id) — the picker's candidates come
   * from props and would otherwise not contain the selected id.
   */
  onCreated: (model: ModelPickerOption) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Offer inline creation when the search finds nothing. */
  allowCreate?: boolean;
}) {
  const selected = useMemo(
    () => models.find((model) => String(model.id) === value) ?? null,
    [models, value],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // The inline create form. While it is open the list must NOT close on the
  // search input's blur — focus moves into the form's own input.
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  // Ticket 07: the loud outcome note after a 409 resolved to the existing
  // row — the server's message plus what the picker did about it.
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listboxId = useId();

  const results = useMemo(() => searchSkus(query, models), [query, models]);

  // Keep the highlight on a real row as the result list shrinks/grows.
  useEffect(() => {
    setHighlight((current) => (results.length === 0 ? 0 : Math.min(current, results.length - 1)));
  }, [results.length]);

  // The highlighted row must stay visible while arrowing through a long list.
  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function select(model: ModelPickerOption): void {
    onChange(String(model.id));
    setOpen(false);
    setQuery("");
    setDuplicateNotice(null);
  }

  // ---- inline creation (ticket 07) ----------------------------------------

  function openCreate(): void {
    setCreateName(query.trim());
    setCreateError(null);
    setCreating(true);
  }

  function closeCreate(): void {
    setCreating(false);
    setCreateError(null);
  }

  async function createModel(): Promise<void> {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await apiJson<ModelPickerOption>("/api/models", {
        name: createName.trim(),
      });
      onCreated(created);
      select(created);
      closeCreate();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The server dedupes case-insensitively, so a 409 means the model
        // EXISTS — the outcome is selecting that row, never a duplicate.
        // The props catalog may be stale (created by another tech after
        // this page loaded), so the match is resolved against a fresh GET,
        // not against local state.
        try {
          const fresh = await api<ModelPickerOption[]>("/api/models");
          const wanted = createName.trim().toLowerCase();
          const existing = fresh.find((model) => model.name.trim().toLowerCase() === wanted);
          if (!existing) {
            // 409 without a matching row is an inconsistency — surface it,
            // never silently pick a look-alike.
            setCreateError(
              `${err.message} — but the refreshed model list has no name matching “${createName.trim()}”. Reload the page and pick the model from the list.`,
            );
            return;
          }
          onCreated(existing);
          select(existing);
          setDuplicateNotice(`${err.message} — selected the existing model “${existing.name}”.`);
          closeCreate();
        } catch (refetchError) {
          setCreateError(
            refetchError instanceof ApiError
              ? `${err.message} (${refetchError.message})`
              : err.message,
          );
        }
      } else {
        setCreateError(err instanceof ApiError ? err.message : "could not create the model");
      }
    } finally {
      setCreateBusy(false);
    }
  }

  // A <form> element here would nest inside the consuming page's form
  // (invalid HTML — the parser strips it), so Enter is handled explicitly.
  function onCreateKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!createBusy) {
        void createModel();
      }
    }
  }

  /** The zero-results create offer, or the expanded inline form. */
  function renderCreate() {
    if (creating) {
      return (
        <div className="sku-picker-create" onKeyDown={onCreateKeyDown}>
          <label>
            Name
            <input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              required
            />
          </label>
          {createError && <span className="status-error">{createError}</span>}
          <span className="table-actions">
            <button type="button" disabled={createBusy} onClick={() => void createModel()}>
              Add model
            </button>
            <button type="button" disabled={createBusy} onClick={closeCreate}>
              Cancel
            </button>
          </span>
        </div>
      );
    }
    return (
      <button
        type="button"
        className="sku-picker-create-row"
        // mousedown would blur the input and close the list before the
        // click lands; keep focus on the input.
        onMouseDown={(event) => event.preventDefault()}
        onClick={openCreate}
      >
        Add “{query.trim()}” as a model
      </button>
    );
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      // While the list is open, Enter picks the highlighted row and must
      // never submit the surrounding form (the add-device modal is a
      // form). Escape closes the list first when form submission is wanted.
      if (open) {
        event.preventDefault();
        if (results.length > 0) {
          select(results[highlight] ?? results[0]);
        }
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setQuery("");
      }
    }
  }

  return (
    <span className="sku-picker">
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        value={open ? query : (selected?.name ?? "")}
        placeholder={selected ? undefined : placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlight(0);
          setDuplicateNotice(null);
        }}
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onBlur={() => {
          // While the inline create form is open the list must stay open —
          // focus moves into the form's input, which blurs the search box.
          if (!creating) {
            setOpen(false);
            setQuery("");
          }
        }}
        onKeyDown={onInputKeyDown}
      />
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          className="sku-picker-list"
          role="listbox"
        >
          {models.length === 0 && <li className="sku-picker-empty">No models yet</li>}
          {models.length > 0 && results.length === 0 && (
            <li className="sku-picker-empty">
              {allowCreate ? "No results found." : `No model matches “${query.trim()}”`}
            </li>
          )}
          {results.map((model, index) => (
            <li
              key={model.id}
              role="option"
              aria-selected={String(model.id) === value}
              className={
                "sku-picker-option" + (index === highlight ? " sku-picker-option-active" : "")
              }
              // mousedown would blur the input and close the list before
              // the click lands; keep focus on the input.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(model)}
            >
              <span className="sku-picker-name">{model.name}</span>
            </li>
          ))}
          {/* Ticket 07: the create offer appears only when the search finds
              NOTHING — its job is to fill a gap, not to sit under matching
              results inviting a near-duplicate. The inline form stays open
              even if the query is then cleared. */}
          {allowCreate && (creating || (query.trim() !== "" && results.length === 0)) && (
            renderCreate()
          )}
        </ul>
      )}
      {!open && duplicateNotice && <span className="status-warn">{duplicateNotice}</span>}
      {!open && selected && (
        <span className="sku-picker-selected">
          <span className="sku-picker-name">{selected.name}</span>
        </span>
      )}
    </span>
  );
}
