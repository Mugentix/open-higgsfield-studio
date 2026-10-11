import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import "@/openhiggsfield/openhiggsfield.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-ohf-inter", display: "swap" });

/* The one panel every page outside the studio is: sign-in, an invitation,
   the first team. Same ground, same panel, so arriving feels like arriving. */
export function Gate({ title, copy, children }: { title: string; copy?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`ohf ${inter.variable}`}>
      <main className="ohf-gate">
        <div className="ohf-dialog-panel ohf-keys-panel ohf-gate-panel">
          <div className="ohf-keys-head">
            <div>
              <div className="ohf-keys-title">{title}</div>
              {copy && <p className="ohf-keys-copy">{copy}</p>}
            </div>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
