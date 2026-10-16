import { z } from "zod";

import { supplierById } from "./catalog";

// Where each supplier gets paid. GuardBuy looks this up itself, never the LLM: the address is
// recorded with the proposal (under the hash chain) and the executor pays exactly that address.
// Demo: env vars, with one sandbox account playing every supplier. The merchant's own
// products & suppliers table replaces this (Oct 17).

/** The supplier's PayPal email, or null if none is on file. */
export function supplierPaymentEmail(supplierId: string): string | null {
  if (!supplierById(supplierId)) return null;
  const key = `SUPPLIER_EMAIL_${supplierId.toUpperCase().replace(/-/g, "_")}`;
  const email = process.env[key] ?? process.env.SUPPLIER_EMAIL;
  return z.email().safeParse(email).success ? email! : null; // a malformed address counts as none on file
}
