"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { updateProduct, type ProductSummary } from "@/server/project-actions";

import { CloseIcon } from "./icons";

export type ProductDialogProduct = Pick<ProductSummary, "id" | "name" | "offerUrl" | "brandNotes">;

/* The product's brief, behind Edit product in the sidebar's menu: its name,
   where the offer lives and how the brand speaks. Templates fill {{product}},
   {{offer_url}} and {{brand_notes}} from these, so the dialog says so — an
   empty field here is a question the composer will ask instead. Same panel
   as the team dialog. */
export function ProductDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductDialogProduct;
  onClose: () => void;
  /** The brief changed: the workspace is stale. */
  onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(product.name);
  const [offerUrl, setOfferUrl] = useState(product.offerUrl ?? "");
  const [brandNotes, setBrandNotes] = useState(product.brandNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Opens on the name, and hands focus back to the control that opened it —
     the pencil on the product's row. The opener is read once into a ref:
     React runs this effect twice in development, and a second read would
     find the dialog's own field. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    nameRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await updateProduct({ productId: product.id, name, offerUrl, brandNotes });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="ohf-product-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="ohf-dialog-panel ohf-keys-panel ohf-product-panel">
        <div className="ohf-keys-head">
          <div>
            <div id="ohf-product-title" className="ohf-keys-title">
              Edit product
            </div>
            <p className="ohf-keys-copy">
              Templates fill {"{{product}}"}, {"{{offer_url}}"} and {"{{brand_notes}}"} from here.
            </p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <form className="ohf-keys-form" onSubmit={(event) => void onSubmit(event)}>
          <label className="ohf-product-field">
            <span className="ohf-field-label">Name</span>
            <input
              ref={nameRef}
              className="ohf-input"
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="ohf-product-field">
            <span className="ohf-field-label">Offer URL</span>
            <input
              className="ohf-input"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…"
              value={offerUrl}
              maxLength={500}
              onChange={(event) => setOfferUrl(event.target.value)}
            />
          </label>
          <label className="ohf-product-field">
            <span className="ohf-field-label">Brand notes</span>
            <textarea
              className="ohf-input ohf-input--area"
              rows={5}
              placeholder="Voice, claims to avoid, phrases that must appear…"
              value={brandNotes}
              maxLength={4000}
              onChange={(event) => setBrandNotes(event.target.value)}
            />
          </label>

          {error && (
            <div className="ohf-alert" role="alert">
              <span className="ohf-alert-text">{error}</span>
            </div>
          )}

          <div className="ohf-keys-actions">
            <button type="button" className="ohf-btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="ohf-keys-save" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
