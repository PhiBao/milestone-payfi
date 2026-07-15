"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { arcTestnet } from "@/lib/arc";

const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [
    injected({
      shimDisconnect: true
    })
  ],
  transports: {
    [arcTestnet.id]: http()
  },
  ssr: true
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
