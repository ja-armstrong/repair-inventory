import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { apiJson, ApiError } from "../api";
import { matchTier, searchSkus } from "../skuSearch";

/**
 * The SKU picker (ticket 20): the one SKU-selection control in the app.
 * A text input that fuzzy-searches the catalog (see skuSearch.ts for the
 * ranking) over a results list. Every row shows the FULL SKU name — it
 * wraps and is never ellipsized, because "(Grade B)" at the end of a name
 * is exactly the part a truncated dropdown hides — with the Available
 * quantity beneath the name (serialized SKUs only), a "consumable" badge
 * for consumables, the price, and a stale-price marker when the price is
 * stale. Zero-Available SKUs stay visible and selectable (the Need to
 * Order path) — dimmed, count shown as 0.
 *
 * Ticket 24: with `allowCreate`, the picker offers inline SKU creation — the
 * typed query becomes the new name (editable), plus kind and price, POSTed
 * to /api/skus. The created SKU is auto-selected (the consuming flow
 * proceeds exactly as if it had been picked) and handed to `onCreated` so
 * the caller can add it to its catalog list. The create offer is a
 * PERMANENT bottom row of the list — shown even when SKUs match the search —
 * so a new part can be added from any search without clearing the query
 * first.
 *
 * Keyboard: ArrowUp/ArrowDown move the highlight, Enter selects it, Escape
 * closes the list. The control is a plain text input, so a stray scanner
 * scan just filters the list. Clicking a row selects it too.
 *
 * After selection the picked SKU displays in full: the input carries its
 * name and a wrapped line beneath repeats the full name with price and
 * availability, so no part of the name is ever clipped.
 *
 * Ticket 07: with `suggestFor` (the device's model name), SKUs whose names
 * match the model — judged by the SAME ranker (`matchTier` against the
 * model name, the one search implementation) — are suggested: they sort to
 * the top of the list and carry a "for <model>" marker, with and without a
 * typed query. Nothing is hidden — the rest of the catalog stays below,
 * because the catalog carries no model↔SKU table (CONTEXT.md's
 * "compatible part-SKU suggestions" is a name-match, and a hard filter
 * would silently make generic SKUs unfindable on a device row).
 */

export interface SkuPickerOption {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  priceStale: boolean;
  availableCount: number | null;
  /**
   * Ticket 11: the SKU's default source link (free text, e.g.
   * "source.com/part"); null/absent when the SKU has none. Prefills PO-line
   * sources and the parts panel's supplier field — never a lock.
   */
  defaultSourceUrl?: string | null;
}

export function SkuPicker({
  skus,
  kind,
  value,
  onChange,
  placeholder = "Type to search SKUs…",
  emptyMessage = "No matching SKUs",
  autoFocus = false,
  allowCreate = false,
  onCreated,
  suggestFor,
}: {
  /** The full catalog from GET /api/skus. */
  skus: SkuPickerOption[];
  /** Restrict to one kind; omit to offer every SKU. */
  kind?: "serialized" | "consumable";
  /** Selected SKU id as a string, "" when nothing is picked. */
  value: string;
  onChange: (skuId: string) => void;
  placeholder?: string;
  /** Shown when the catalog (after the kind filter) is empty. */
  emptyMessage?: string;
  autoFocus?: boolean;
  /**
   * Ticket 24: offer inline SKU creation when the search finds nothing.
   * The POST goes to the existing /api/skus endpoint; the picker adds
   * nothing to the timeline (the server records sku.created as always).
   */
  allowCreate?: boolean;
  /**
   * Called with the freshly created SKU. The caller MUST add it to its
   * catalog list — the picker's candidates come from props and would
   * otherwise not contain the new id.
   */
  onCreated?: (sku: SkuPickerOption) => void;
  /**
   * Ticket 07: the device's model name, when one is chosen. SKUs matching
   * the model via the shared ranker sort first and carry a "for <model>"
   * marker; omit (or pass blank) for no model-driven ordering.
   */
  suggestFor?: string;
}) {
  const candidates = useMemo(
    () => (kind === undefined ? skus : skus.filter((sku) => sku.kind === kind)),
    [skus, kind],
  );
  const selected = useMemo(
    () => candidates.find((sku) => String(sku.id) === value) ?? null,
    [candidates, value],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Ticket 24: the inline create form. While it is open the list must NOT
  // close on the search input's blur — focus moves into the form's own
  // inputs, and a closed list would destroy the half-typed form.
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    kind: (kind ?? "serialized") as "serialized" | "consumable",
    price: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Several pickers can render on one page (PO lines, the parts panel) —
  // the listbox id must be unique per instance for aria-controls.
  const listboxId = useId();

  // Ticket 07: model-driven suggestion ordering. The ranker's own order is
  // kept WITHIN each group; the model-matching group simply sorts ahead of
  // the rest, so picking a model immediately reshapes the suggestion list.
  const { results, suggestedIds } = useMemo(() => {
    const ranked = searchSkus(query, candidates);
    if (suggestFor === undefined || suggestFor.trim() === "") {
      return { results: ranked, suggestedIds: null as Set<number> | null };
    }
    const suggested = ranked.filter((sku) => matchTier(suggestFor, sku.name) !== null);
    const others = ranked.filter((sku) => matchTier(suggestFor, sku.name) === null);
    return { results: [...suggested, ...others], suggestedIds: new Set(suggested.map((s) => s.id)) };
  }, [query, candidates, suggestFor]);

  // The other kind's matches, as dimmed non-selectable hints (query-gated).
  // WHY: the kind filter is the domain (consumables are recorded as usage,
  // serialized units are reserved) — but a silent filter reads as "the
  // catalog lacks this item" and invites a duplicate SKU of the wrong kind.
  // Showing the match with a pointer at the right form keeps the rule and
  // kills the confusion.
  const hints = useMemo(
    () =>
      kind === undefined
        ? []
        : searchSkus(
            query,
            skus.filter((sku) => sku.kind !== kind),
          ),
    [query, skus, kind],
  );
  const showHints = kind !== undefined && query.trim() !== "" && hints.length > 0;

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

  function select(sku: SkuPickerOption): void {
    onChange(String(sku.id));
    setOpen(false);
    setQuery("");
  }

  // ---- inline creation (ticket 24) ----------------------------------------

  function openCreate(): void {
    setCreateForm({ name: query.trim(), kind: kind ?? "serialized", price: "" });
    setCreateError(null);
    setCreating(true);
  }

  function closeCreate(): void {
    setCreating(false);
    setCreateError(null);
  }

  async function createSku(): Promise<void> {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await apiJson<SkuPickerOption>("/api/skus", {
        name: createForm.name.trim(),
        kind: createForm.kind,
        price: createForm.price.trim(),
      });
      onCreated?.(created);
      select(created);
      closeCreate();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "could not create the SKU");
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
        void createSku();
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
              value={createForm.name}
              onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
              required
            />
          </label>
          <label>
            Kind
            <select
              value={createForm.kind}
              onChange={(event) =>
                setCreateForm({ ...createForm, kind: event.target.value as "serialized" | "consumable" })
              }
            >
              <option value="serialized">serialized</option>
              <option value="consumable">consumable</option>
            </select>
          </label>
          <label>
            Price ($)
            <input
              value={createForm.price}
              onChange={(event) => setCreateForm({ ...createForm, price: event.target.value })}
              placeholder="12.34"
              inputMode="decimal"
              required
            />
          </label>
          {createError && <span className="status-error">{createError}</span>}
          <span className="table-actions">
            <button type="button" disabled={createBusy} onClick={() => void createSku()}>
              Create SKU
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
        Add “{query.trim()}” as a SKU
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
      // never submit the surrounding form — even with no results (a PO
      // line form would otherwise post itself). Escape closes the list
      // first when plain form submission is wanted.
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
        }}
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onBlur={() => {
          // While the inline create form is open the list must stay open —
          // focus moves into the form's inputs, which blurs the search box.
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
          {candidates.length === 0 && (
            <li className="sku-picker-empty">{emptyMessage}</li>
          )}
          {candidates.length > 0 && results.length === 0 && (
            <li className="sku-picker-empty">
              {allowCreate ? "No results found." : `No SKU matches “${query.trim()}”`}
            </li>
          )}
          {results.map((sku, index) => (
            <li
              key={sku.id}
              role="option"
              aria-selected={String(sku.id) === value}
              className={
                "sku-picker-option" +
                (index === highlight ? " sku-picker-option-active" : "") +
                // Zero-Available serialized SKUs stay selectable (the Need
                // to Order path) — they are only dimmed.
                (sku.kind === "serialized" && sku.availableCount === 0
                  ? " sku-picker-option-empty"
                  : "")
              }
              // mousedown would blur the input and close the list before
              // the click lands; keep focus on the input.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(sku)}
            >
              <span className="sku-picker-name">{sku.name}</span>
              <span className="sku-picker-meta">
                {suggestedIds?.has(sku.id) && (
                  // Ticket 07: the visible marker that this SKU is a
                  // suggestion for the device's chosen model.
                  <span className="sku-picker-badge">for {suggestFor}</span>
                )}
                {sku.kind === "serialized" ? (
                  <span className="sku-picker-count">
                    Available: {sku.availableCount ?? 0}
                  </span>
                ) : (
                  <span className="sku-picker-badge">consumable</span>
                )}
                <span className="sku-picker-price">{sku.price}</span>
                {sku.priceStale && <span className="sku-picker-stale">price stale</span>}
              </span>
            </li>
          ))}
          {showHints && (
            <>
              <li className="sku-picker-empty">Also in the catalog — not selectable here:</li>
              {hints.map((sku) => (
                <li
                  key={`hint-${sku.id}`}
                  className="sku-picker-option sku-picker-option-hint"
                >
                  <span className="sku-picker-name">{sku.name}</span>
                  <span className="sku-picker-meta">
                    <span className="sku-picker-badge">{sku.kind}</span>
                    <span>
                      {sku.kind === "consumable"
                        ? "consumable — its cost is recorded as usage on a device (quantity × price)"
                        : "serialized — reserved onto a device as a unit"}
                    </span>
                  </span>
                </li>
              ))}
            </>
          )}
          {/* Ticket 24 follow-up: the create offer is a PERMANENT bottom row —
              even when SKUs match — so a new part can be added from any
              search without clearing the query first. The inline form stays
              open even if the query is then cleared. */}
          {allowCreate && (creating || query.trim() !== "") && renderCreate()}
        </ul>
      )}
      {!open && selected && (
        <span className="sku-picker-selected">
          <span className="sku-picker-name">{selected.name}</span>
          <span className="sku-picker-meta">
            {selected.kind === "serialized" ? (
              <span className="sku-picker-count">
                Available: {selected.availableCount ?? 0}
              </span>
            ) : (
              <span className="sku-picker-badge">consumable</span>
            )}
            <span className="sku-picker-price">{selected.price}</span>
            {selected.priceStale && <span className="sku-picker-stale">price stale</span>}
          </span>
        </span>
      )}
    </span>
  );
}
