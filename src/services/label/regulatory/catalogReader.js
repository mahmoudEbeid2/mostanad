// §2's structural enforcement: "example teaches FORMAT ONLY... expose two
// catalog readers — a full one, and a STRIPPED one that never returns
// `example`. The generation path imports only the stripped reader. A comment
// is not enforcement." readCatalogStripped deletes the key outright (it is
// absent from the returned object, not merely undocumented) so a caller can't
// accidentally forward it downstream even by spreading the whole object.
export function readCatalogFull(catalog) {
  return catalog || null;
}

export function readCatalogStripped(catalog) {
  if (!catalog) return null;
  return {
    ...catalog,
    fields: (catalog.fields || []).map((field) => {
      const { example, ...rest } = field;
      return rest;
    }),
  };
}
