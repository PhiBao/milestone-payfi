"use client";

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Coins,
  ExternalLink,
  FileClock,
  FileCheck2,
  History,
  Layers3,
  Link2,
  Play,
  Plus,
  ReceiptText,
  RefreshCcw,
  Send,
  ShieldCheck,
  Users,
  Zap,
  WalletCards
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { decodeEventLog, formatUnits, isAddress, type Hex, type PublicClient, type WalletClient } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient
} from "wagmi";
import { arcAddressUrl, arcTestnet, arcTxUrl, ARC_FAUCET_URL } from "@/lib/arc";
import { BridgePanel } from "@/components/bridge-panel";
import {
  contractsConfigured,
  deployment,
  erc20Abi,
  milestoneEscrowAbi,
  receivablePoolAbi
} from "@/lib/contracts";
import { formatUsdc, friendlyDate, parseUsdc, shortAddress } from "@/lib/format";
import { buildRiskReview, riskTierIndex } from "@/lib/risk";
import type { ContractListResponse, Milestone, RiskReview, WorkContract } from "@/lib/payfi-types";

const statusCopy: Record<Milestone["status"], string> = {
  draft: "Draft",
  created_onchain: "Created onchain",
  funded: "Funded",
  submitted: "Submitted",
  approved: "Approved",
  early_paid: "Paid now",
  released: "Released",
  cancelled: "Cancelled"
};

const statusRank: Record<Milestone["status"], number> = {
  draft: 0,
  created_onchain: 1,
  funded: 2,
  submitted: 3,
  approved: 4,
  early_paid: 5,
  released: 6,
  cancelled: 7
};

const defaultRelease = () => new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 16);
const localDateTime = (offsetMinutes: number) =>
  new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString().slice(0, 16);

const journeySteps: Array<{ status: Milestone["status"]; label: string; detail: string }> = [
  { status: "draft", label: "Terms", detail: "Payment room ready" },
  { status: "funded", label: "Escrow funded", detail: "USDC protected" },
  { status: "approved", label: "Work approved", detail: "Pay-now unlocked" },
  { status: "released", label: "Paid", detail: "Settlement complete" }
];

interface FormState {
  title: string;
  summary: string;
  clientName: string;
  clientEmail: string;
  clientAddress: string;
  freelancerName: string;
  freelancerEmail: string;
  freelancerAddress: string;
  creatorRole: "client" | "freelancer";
  milestoneTitle: string;
  deliverable: string;
  amountUsdc: string;
  releaseAtLocal: string;
}

type FormFieldKey = keyof FormState | "releaseAt";
type FieldErrors = Partial<Record<FormFieldKey, string>>;

const emptyForm: FormState = {
  title: "",
  summary: "",
  clientName: "",
  clientEmail: "",
  clientAddress: "",
  freelancerName: "",
  freelancerEmail: "",
  freelancerAddress: "",
  creatorRole: "client",
  milestoneTitle: "",
  deliverable: "",
  amountUsdc: "",
  releaseAtLocal: defaultRelease()
};

const fieldLabels: Record<FormFieldKey, string> = {
  title: "Task title",
  summary: "Summary",
  clientName: "Client name",
  clientEmail: "Client email",
  clientAddress: "Client wallet",
  freelancerName: "Freelancer name",
  freelancerEmail: "Freelancer email",
  freelancerAddress: "Freelancer wallet",
  creatorRole: "Creator role",
  milestoneTitle: "Milestone title",
  deliverable: "Deliverable",
  amountUsdc: "Amount USDC",
  releaseAtLocal: "Release time",
  releaseAt: "Release time"
};

type ContractWriteParams = {
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

type ContractReadParams = ContractWriteParams;
type ViewMode = "client" | "freelancer" | "liquidity";

interface ChainSnapshot {
  availableUsdc: string;
  totalPoolUsdc: string;
  outstandingUsdc: string;
  maxAdvanceUsdc: string;
  maxReceivableTenorDays?: number;
  clientExposureCapUsdc?: string;
  freelancerExposureCapUsdc?: string;
  clientOutstandingUsdc?: string;
  freelancerOutstandingUsdc?: string;
  utilizationCapBps: number;
  baseDiscountBps: number;
  annualizedDiscountBps: number | null;
  maxDiscountBps: number;
  paused: boolean;
  poolOwner?: string;
  riskPolicySupported: boolean;
  riskPolicyPublished?: boolean;
  riskPolicy?: {
    tier: RiskReview["tier"];
    maxAdvanceBps: number;
    baseDiscountBps: number;
    annualizedDiscountBps: number;
    maxDiscountBps: number;
    riskHash: Hex;
  };
  quoteUsdc?: string;
  quoteDiscountBps?: number;
  walletBalanceUsdc?: string;
  escrowAllowanceUsdc?: string;
}

async function writeTx(walletClient: WalletClient, params: ContractWriteParams) {
  if (!walletClient.account) throw new Error("Wallet account is not ready.");
  return walletClient.writeContract({
    ...params,
    account: walletClient.account
  } as Parameters<WalletClient["writeContract"]>[0]) as Promise<Hex>;
}

async function readTx<T>(publicClient: PublicClient, params: ContractReadParams) {
  return publicClient.readContract(params as Parameters<PublicClient["readContract"]>[0]) as Promise<T>;
}

function isRejectedRequest(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "UserRejectedRequestError" || /rejected/i.test(error.message);
}

function extractFieldErrors(details: unknown): FieldErrors {
  if (!details || typeof details !== "object" || !("fieldErrors" in details)) return {};
  const fieldErrors = (details as { fieldErrors?: Record<string, string[] | undefined> }).fieldErrors;
  if (!fieldErrors) return {};

  return Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([, errors]) => errors?.[0])
      .map(([field, errors]) => [field, errors?.[0]])
  ) as FieldErrors;
}

function summarizeFieldErrors(fieldErrors: FieldErrors) {
  const labels = Object.keys(fieldErrors).map((field) => fieldLabels[field as FormFieldKey] ?? field);
  if (labels.length === 0) return "Could not create task.";
  if (labels.length === 1) return `Fix ${labels[0]} to create this task room.`;
  return `Fix ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and other fields" : ""} to create this task room.`;
}

function riskTierName(index: number): RiskReview["tier"] {
  if (index === 0) return "A";
  if (index === 1) return "B";
  if (index === 2) return "C";
  return "Blocked";
}

export function MilestonePayFiApp() {
  const [contracts, setContracts] = useState<WorkContract[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submissionNote, setSubmissionNote] = useState("Delivered work link and handoff notes.");
  const [submissionUrl, setSubmissionUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [viewMode, setViewMode] = useState<ViewMode>("client");
  const [composerOpen, setComposerOpen] = useState(false);
  const [chainSnapshot, setChainSnapshot] = useState<ChainSnapshot | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: arcTestnet.id });

  const configured = contractsConfigured();
  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const selectedContract = contracts.find((contract) => contract.id === selectedId) ?? null;
  const selectedMilestone = selectedContract?.milestones[0] ?? null;

  const totals = useMemo(() => {
    const milestones = selectedContract?.milestones ?? [];
    return {
      contractValue: milestones.reduce((total, milestone) => total + Number(milestone.amountUsdc), 0),
      funded: milestones
        .filter((milestone) => statusRank[milestone.status] >= statusRank.funded)
        .reduce((total, milestone) => total + Number(milestone.amountUsdc), 0),
      approved: milestones
        .filter((milestone) => milestone.status === "approved" || milestone.status === "early_paid")
        .reduce((total, milestone) => total + Number(milestone.amountUsdc), 0)
    };
  }, [selectedContract]);

  const loadContracts = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch("/api/contracts", { cache: "no-store" });
    const data = (await response.json()) as ContractListResponse;
    setContracts(data.contracts);
    setIsLoading(false);
  }, []);

  const loadChainSnapshot = useCallback(async () => {
    if (!configured || !publicClient || !deployment.pool || !deployment.usdc) {
      setChainSnapshot(null);
      return;
    }

    async function readPool<T>(functionName: string, args: readonly unknown[] = []) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await readTx<T>(publicClient as PublicClient, {
            address: deployment.pool!,
            abi: receivablePoolAbi,
            functionName,
            args
          });
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      return null;
    }

    async function readUsdc<T>(functionName: string, args: readonly unknown[] = []) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await readTx<T>(publicClient as PublicClient, {
            address: deployment.usdc!,
            abi: erc20Abi,
            functionName,
            args
          });
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      return null;
    }

    const [
      availableLiquidity,
      totalPoolValue,
      outstanding,
      maxAdvance,
      utilizationCap,
      paused,
      baseDiscount,
      annualizedDiscount,
      maxDiscount,
      legacyDiscount,
      poolOwner,
      maxReceivableTenor,
      clientExposureCap,
      freelancerExposureCap
    ] = await Promise.all([
      readPool<bigint>("availableLiquidity"),
      readPool<bigint>("totalPoolValue"),
      readPool<bigint>("outstanding"),
      readPool<bigint>("maxAdvance"),
      readPool<bigint>("utilizationCapBps"),
      readPool<boolean>("paused"),
      readPool<bigint>("baseDiscountBps"),
      readPool<bigint>("annualizedDiscountBps"),
      readPool<bigint>("maxDiscountBps"),
      readPool<bigint>("discountBps"),
      readPool<string>("owner"),
      readPool<bigint>("maxReceivableTenor"),
      readPool<bigint>("clientExposureCap"),
      readPool<bigint>("freelancerExposureCap")
    ]);

    const onchainId = selectedMilestone?.onchainId ? BigInt(selectedMilestone.onchainId) : null;
    const [quote, quoteDiscount, walletBalance, escrowAllowance, riskPolicy, clientOutstanding, freelancerOutstanding] = await Promise.all([
      onchainId ? readPool<bigint>("quoteAdvance", [onchainId]) : Promise.resolve(null),
      onchainId ? readPool<bigint>("quoteDiscountBps", [onchainId]) : Promise.resolve(null),
      address ? readUsdc<bigint>("balanceOf", [address]) : Promise.resolve(null),
      address && deployment.escrow ? readUsdc<bigint>("allowance", [address, deployment.escrow]) : Promise.resolve(null),
      onchainId
        ? readPool<readonly [boolean, number, number, number, number, number, Hex]>("riskPolicies", [onchainId])
        : Promise.resolve(null),
      selectedContract ? readPool<bigint>("outstandingByClient", [selectedContract.clientAddress]) : Promise.resolve(null),
      selectedContract ? readPool<bigint>("outstandingByFreelancer", [selectedContract.freelancerAddress]) : Promise.resolve(null)
    ]);

    const fallbackDiscount = legacyDiscount ?? 180n;
    const riskPolicySupported = riskPolicy !== null;
    const publishedPolicy = riskPolicySupported && riskPolicy?.[0]
      ? {
          tier: riskTierName(Number(riskPolicy[1])),
          maxAdvanceBps: Number(riskPolicy[2]),
          baseDiscountBps: Number(riskPolicy[3]),
          annualizedDiscountBps: Number(riskPolicy[4]),
          maxDiscountBps: Number(riskPolicy[5]),
          riskHash: riskPolicy[6]
        }
      : undefined;

    setChainSnapshot({
      availableUsdc: formatUnits(availableLiquidity ?? 0n, 6),
      totalPoolUsdc: formatUnits(totalPoolValue ?? availableLiquidity ?? 0n, 6),
      outstandingUsdc: formatUnits(outstanding ?? 0n, 6),
      maxAdvanceUsdc: formatUnits(maxAdvance ?? 0n, 6),
      maxReceivableTenorDays: maxReceivableTenor === null ? undefined : Number(maxReceivableTenor) / 86400,
      clientExposureCapUsdc: clientExposureCap === null ? undefined : formatUnits(clientExposureCap, 6),
      freelancerExposureCapUsdc: freelancerExposureCap === null ? undefined : formatUnits(freelancerExposureCap, 6),
      clientOutstandingUsdc: clientOutstanding === null ? undefined : formatUnits(clientOutstanding, 6),
      freelancerOutstandingUsdc: freelancerOutstanding === null ? undefined : formatUnits(freelancerOutstanding, 6),
      utilizationCapBps: Number(utilizationCap ?? 0n),
      baseDiscountBps: Number(baseDiscount ?? fallbackDiscount),
      annualizedDiscountBps: annualizedDiscount === null ? null : Number(annualizedDiscount),
      maxDiscountBps: Number(maxDiscount ?? fallbackDiscount),
      paused: Boolean(paused),
      poolOwner: poolOwner ?? undefined,
      riskPolicySupported,
      riskPolicyPublished: Boolean(riskPolicy?.[0]),
      riskPolicy: publishedPolicy,
      quoteUsdc: quote === null ? undefined : formatUnits(quote, 6),
      quoteDiscountBps: quoteDiscount === null
        ? riskPolicySupported
          ? undefined
          : Number(fallbackDiscount)
        : Number(quoteDiscount),
      walletBalanceUsdc: walletBalance === null ? undefined : formatUnits(walletBalance, 6),
      escrowAllowanceUsdc: escrowAllowance === null ? undefined : formatUnits(escrowAllowance, 6)
    });
  }, [address, configured, publicClient, selectedContract, selectedMilestone?.onchainId]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  useEffect(() => {
    loadChainSnapshot();
  }, [loadChainSnapshot]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const contractId = params.get("contract");
    if (contractId) setSelectedId(contractId);
  }, []);

  useEffect(() => {
    if (!address) return;
    const creatorRole = form.creatorRole;
    setForm((current) => ({
      ...current,
      clientAddress: creatorRole === "client" ? address : current.clientAddress,
      freelancerAddress: creatorRole === "freelancer" ? address : current.freelancerAddress
    }));
    setFieldErrors((current) => ({
      ...current,
      clientAddress: creatorRole === "client" ? undefined : current.clientAddress,
      freelancerAddress: creatorRole === "freelancer" ? undefined : current.freelancerAddress
    }));
  }, [address, form.creatorRole]);

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({
      ...current,
      [field]: undefined,
      releaseAt: field === "releaseAtLocal" ? undefined : current.releaseAt
    }));
  }

  function loadJudgeDemo() {
    const demoAddress = address ?? "";
    setForm({
      title: "Cross-border launch sprint for Orbit Studio",
      summary: "A funded launch sprint where accepted work can be paid immediately while escrow settles on schedule.",
      clientName: "Orbit Studio",
      clientEmail: "finance@orbit.example",
      clientAddress: demoAddress,
      freelancerName: "Maya Rivera",
      freelancerEmail: "maya@example.dev",
      freelancerAddress: demoAddress,
      creatorRole: "client",
      milestoneTitle: "Launch page, analytics, and handoff",
      deliverable: "Production landing page, analytics events, source files, and launch QA notes.",
      amountUsdc: "1",
      releaseAtLocal: localDateTime(-1)
    });
    setSubmissionNote("Delivered the production URL, source branch, analytics checklist, and launch QA notes.");
    setSubmissionUrl("https://example.com/launch-handoff");
    setFieldErrors({});
    setError(null);
    setComposerOpen(true);
  }

  async function syncSelectedFromChain() {
    if (!selectedContract) return;
    setError(null);
    setSyncMessage(null);
    setIsSyncing(true);
    try {
      const response = await fetch(`/api/contracts/${selectedContract.id}/sync`, {
        method: "POST"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not sync from Arc.");
      setContracts((current) =>
        current.map((item) => (item.id === selectedContract.id ? data.contract : item))
      );
      setSyncMessage("Synced from Arc contract state.");
      await loadChainSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sync from Arc.");
    } finally {
      setIsSyncing(false);
    }
  }

  function validateBeforeSubmit() {
    const nextErrors: FieldErrors = {};
    if (!isAddress(form.clientAddress)) nextErrors.clientAddress = "Paste a valid EVM wallet address for the client.";
    if (!isAddress(form.freelancerAddress)) {
      nextErrors.freelancerAddress = "Paste a valid EVM wallet address for the freelancer.";
    }
    if (!form.releaseAtLocal || Number.isNaN(new Date(form.releaseAtLocal).getTime())) {
      nextErrors.releaseAtLocal = "Choose a valid release time.";
    }
    if (!/^\d+(\.\d{1,6})?$/.test(form.amountUsdc.trim())) {
      nextErrors.amountUsdc = "Use a USDC amount with up to 6 decimals.";
    }
    setFieldErrors(nextErrors);
    return nextErrors;
  }

  async function connectWallet() {
    setError(null);
    const connector = connectors[0];
    if (!connector) {
      setError("No injected wallet found. Install MetaMask, Rabby, or Coinbase Wallet.");
      return;
    }

    try {
      await connectAsync({ connector, chainId: arcTestnet.id });
    } catch (err) {
      setError(
        isRejectedRequest(err)
          ? "Wallet connection was rejected. You can still create a task by pasting both participant wallet addresses, or connect again and approve the wallet prompt."
          : err instanceof Error
            ? err.message
            : "Could not connect wallet."
      );
    }
  }

  async function ensureReady() {
    if (!configured) {
      throw new Error("Contract addresses are not configured. Deploy contracts and set NEXT_PUBLIC_* env vars.");
    }
    if (!isConnected) throw new Error("Connect a wallet first.");
    if (wrongNetwork) {
      await switchChainAsync({ chainId: arcTestnet.id });
    }
    if (!walletClient || !publicClient) throw new Error("Wallet client is not ready.");
    return {
      walletClient: walletClient as WalletClient,
      publicClient: publicClient as PublicClient
    };
  }

  async function switchToArc() {
    setError(null);
    try {
      await switchChainAsync({ chainId: arcTestnet.id });
    } catch (err) {
      setError(
        isRejectedRequest(err)
          ? "Network switch was rejected. Switch to Arc Testnet in your wallet to continue."
          : err instanceof Error
            ? err.message
            : "Could not switch network."
      );
    }
  }

  async function persistEvent(
    contract: WorkContract,
    milestone: Milestone,
    action: string,
    args: Record<string, unknown> = {}
  ) {
    if (!address) throw new Error("Missing connected wallet address.");

    // Optimistically update local React state before the API call, so the UI
    // shows the correct next action even when the server store is unavailable
    // (e.g. Vercel deploys without DATABASE_URL / POSTGRES_URL). The server-
    // verified response replaces this optimistic version on success.
    const localStatus: Record<string, Milestone["status"]> = {
      onchain_created: "created_onchain",
      client_funded: "funded",
      work_submitted: "submitted",
      client_approved: "approved",
      risk_reviewed: "approved",
      early_payout_taken: "early_paid",
      scheduled_release: "released",
      cancelled: "cancelled"
    };
    const localReceiptType: Record<string, string> = {
      onchain_created: "onchain_created",
      client_funded: "client_funded",
      work_submitted: "work_submitted",
      client_approved: "client_approved",
      risk_reviewed: "risk_reviewed",
      early_payout_taken: "early_payout_taken",
      scheduled_release: "scheduled_release",
      cancelled: "cancelled"
    };
    const localLabels: Record<string, string> = {
      onchain_created: `${milestone.title} was created on Arc Testnet escrow.`,
      client_funded: `${contract.clientName} funded ${milestone.title}.`,
      work_submitted: `${contract.freelancerName} submitted work for ${milestone.title}.`,
      client_approved: `${contract.clientName} approved ${milestone.title}; receivable born.`,
      risk_reviewed: `Pool risk policy was published for ${milestone.title}.`,
      early_payout_taken: `${contract.freelancerName} took early payout of ${milestone.title}.`,
      scheduled_release: `${milestone.title} was released and settled on Arc Testnet.`,
      cancelled: `${milestone.title} was cancelled.`
    };
    const now = new Date().toISOString();
    const newStatus = localStatus[action];
    const receiptType = localReceiptType[action];
    const label = localLabels[action] || `${milestone.title} updated.`;

    setContracts((current) =>
      current.map((item) => {
        if (item.id !== contract.id) return item;
        return {
          ...item,
          milestones: item.milestones.map((m) => {
            if (m.id !== milestone.id) return m;
            return {
              ...m,
              status: newStatus ?? m.status,
              txHash: args.txHash ? (args.txHash as `0x${string}`) : m.txHash,
              onchainId: args.onchainId ? (args.onchainId as string) : m.onchainId,
              submissionNote: args.submissionNote ? (args.submissionNote as string) : m.submissionNote,
              submissionUrl: args.submissionUrl ? (args.submissionUrl as string) : m.submissionUrl,
              advanceUsdc: args.advanceUsdc ? (args.advanceUsdc as string) : m.advanceUsdc,
              riskReview: args.riskReview ? (args.riskReview as import("@/lib/payfi-types").RiskReview) : m.riskReview
            };
          }),
          receipts: [
            {
              id: ["r", Date.now().toString(36), Math.random().toString(36).slice(2, 8)].join("_"),
              type: receiptType as import("@/lib/payfi-types").ReceiptType,
              actorAddress: address,
              label,
              txHash: args.txHash as `0x${string}` | undefined,
              createdAt: now
            },
            ...item.receipts
          ]
        };
      })
    );
    setSelectedId(contract.id);

    let serverContract: WorkContract | null = null;
    try {
      const response = await fetch(`/api/contracts/${contract.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          milestoneId: milestone.id,
          action,
          actorAddress: address,
          ...args
        })
      });
      const data = await response.json();
      if (response.ok) {
        serverContract = data.contract as WorkContract;
        setContracts((current) =>
          current.map((item) => (item.id === contract.id ? serverContract! : item))
        );
        setSelectedId(contract.id);
      } else {
        throw new Error(data.error || "Could not persist event.");
      }
    } catch (serverError) {
      const message = serverError instanceof Error ? serverError.message : String(serverError);
      console.warn("Room event persisted locally; server store unavailable:", message);
      setError(
        `State saved in your browser, but the server store is unreachable. ` +
          `On Vercel: set DATABASE_URL or POSTGRES_URL in the deployment env. ` +
          `Current data will be lost on refresh. (${message})`
      );
    }

    await loadChainSnapshot();
    return serverContract ?? contract;
  }

  async function createContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setIsCreating(true);

    try {
      const clientErrors = validateBeforeSubmit();
      if (Object.keys(clientErrors).length > 0) {
        throw new Error(summarizeFieldErrors(clientErrors));
      }
      const releaseAt = new Date(form.releaseAtLocal).toISOString();
      const response = await fetch("/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          releaseAt
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const apiFieldErrors = extractFieldErrors(data.details);
        setFieldErrors(apiFieldErrors);
        throw new Error(summarizeFieldErrors(apiFieldErrors) || data.error || "Could not create task.");
      }
      setContracts((current) => [data.contract, ...current]);
      setSelectedId(data.contract.id);
      setComposerOpen(false);
      window.history.replaceState(null, "", `/?contract=${data.contract.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setIsCreating(false);
    }
  }

  async function sendContractTx(label: string, work: () => Promise<{ hash: Hex; onchainId?: string; advanceUsdc?: string }>) {
    setError(null);
    setPendingLabel(label);
    try {
      return await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed.");
      return undefined;
    } finally {
      setPendingLabel(null);
    }
  }

  async function createOnchain(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const hash = await writeTx(walletClient, {
      address: deployment.escrow!,
      abi: milestoneEscrowAbi,
      functionName: "createMilestone",
      args: [
        contract.freelancerAddress,
        contract.clientAddress,
        parseUsdc(milestone.amountUsdc),
        BigInt(Math.floor(new Date(milestone.releaseAt).getTime() / 1000)),
        milestone.metadataHash
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    let onchainId: string | undefined;

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: milestoneEscrowAbi,
          data: log.data,
          topics: log.topics
        });
        if (decoded.eventName === "MilestoneCreated") {
          onchainId = decoded.args.milestoneId.toString();
        }
      } catch {
        // Ignore logs from unrelated contracts.
      }
    }

    if (!onchainId) throw new Error("Could not find MilestoneCreated event in receipt.");
    await persistEvent(contract, milestone, "onchain_created", { txHash: hash, onchainId });
  }

  async function approveUsdc(milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const hash = await writeTx(walletClient, {
      address: deployment.usdc!,
      abi: erc20Abi,
      functionName: "approve",
      args: [deployment.escrow!, parseUsdc(milestone.amountUsdc)]
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function fundEscrow(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const hash = await writeTx(walletClient, {
      address: deployment.escrow!,
      abi: milestoneEscrowAbi,
      functionName: "fund",
      args: [BigInt(milestone.onchainId!)]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "client_funded", { txHash: hash });
  }

  async function submitWork(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const hash = await writeTx(walletClient, {
      address: deployment.escrow!,
      abi: milestoneEscrowAbi,
      functionName: "submit",
      args: [BigInt(milestone.onchainId!)]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "work_submitted", {
      txHash: hash,
      submissionNote,
      submissionUrl: submissionUrl || undefined
    });
  }

  async function approveWork(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const hash = await writeTx(walletClient, {
      address: deployment.escrow!,
      abi: milestoneEscrowAbi,
      functionName: "approve",
      args: [BigInt(milestone.onchainId!)]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "client_approved", { txHash: hash });
  }

  async function publishRiskPolicy(contract: WorkContract, milestone: Milestone, review: RiskReview) {
    const { walletClient, publicClient } = await ensureReady();
    if (!milestone.onchainId) throw new Error("Create the onchain milestone before publishing risk.");
    if (!chainSnapshot?.riskPolicySupported) {
      throw new Error("This pool deployment does not support v2 risk policies. Redeploy the v2 pool first.");
    }
    if (review.hardBlock) {
      throw new Error("This receivable is blocked by the risk model and cannot be advanced.");
    }

    const hash = await writeTx(walletClient, {
      address: deployment.pool!,
      abi: receivablePoolAbi,
      functionName: "setReceivableRisk",
      args: [
        BigInt(milestone.onchainId),
        riskTierIndex(review.tier),
        review.maxAdvanceBps,
        review.baseDiscountBps,
        review.annualizedDiscountBps,
        review.maxDiscountBps,
        review.riskHash
      ]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "risk_reviewed", {
      txHash: hash,
      riskReview: review
    });
  }

  async function takeAdvance(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    const quote = await readTx<bigint>(publicClient, {
      address: deployment.pool!,
      abi: receivablePoolAbi,
      functionName: "quoteAdvance",
      args: [BigInt(milestone.onchainId!)]
    });
    const hash = await writeTx(walletClient, {
      address: deployment.pool!,
      abi: receivablePoolAbi,
      functionName: "requestAdvance",
      args: [BigInt(milestone.onchainId!)]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "early_payout_taken", {
      txHash: hash,
      advanceUsdc: formatUnits(quote, 6)
    });
  }

  async function release(contract: WorkContract, milestone: Milestone) {
    const { walletClient, publicClient } = await ensureReady();
    let hash: Hex;
    try {
      hash = await writeTx(walletClient, {
        address: deployment.pool!,
        abi: receivablePoolAbi,
        functionName: "releaseReceivable",
        args: [BigInt(milestone.onchainId!)]
      });
    } catch {
      hash = await writeTx(walletClient, {
        address: deployment.escrow!,
        abi: milestoneEscrowAbi,
        functionName: "release",
        args: [BigInt(milestone.onchainId!)]
      });
    }
    await publicClient.waitForTransactionReceipt({ hash });
    await persistEvent(contract, milestone, "scheduled_release", { txHash: hash });
  }

  const roleForWallet = useMemo(() => {
    if (!address || !selectedContract) return null;
    const isClient = address.toLowerCase() === selectedContract.clientAddress.toLowerCase();
    const isFreelancer = address.toLowerCase() === selectedContract.freelancerAddress.toLowerCase();
    if (isClient && isFreelancer) return "both";
    if (isClient) return "client";
    if (isFreelancer) return "freelancer";
    return "viewer";
  }, [address, selectedContract]);

  const riskReview = useMemo(() => {
    if (!selectedContract || !selectedMilestone) return null;
    return buildRiskReview(selectedContract, selectedMilestone, {
      availableUsdc: chainSnapshot?.availableUsdc,
      outstandingUsdc: chainSnapshot?.outstandingUsdc,
      maxAdvanceUsdc: chainSnapshot?.maxAdvanceUsdc,
      utilizationCapBps: chainSnapshot?.utilizationCapBps,
      clientOutstandingUsdc: chainSnapshot?.clientOutstandingUsdc,
      freelancerOutstandingUsdc: chainSnapshot?.freelancerOutstandingUsdc,
      clientExposureCapUsdc: chainSnapshot?.clientExposureCapUsdc,
      freelancerExposureCapUsdc: chainSnapshot?.freelancerExposureCapUsdc
    });
  }, [chainSnapshot, selectedContract, selectedMilestone]);

  const isPoolOwner =
    Boolean(address && chainSnapshot?.poolOwner && address.toLowerCase() === chainSnapshot.poolOwner.toLowerCase());

  const currentAmount = selectedMilestone ? formatUsdc(selectedMilestone.amountUsdc) : "Set amount";
  const roomTitle = selectedContract
    ? `${selectedContract.clientName} pays ${selectedContract.freelancerName}`
    : "Create a protected work payment";
  const roomSubtitle = selectedContract
    ? selectedContract.summary
    : "Fund the milestone before work starts, approve accepted work, and let the freelancer take pay-now liquidity.";
  const payNowValue = chainSnapshot?.quoteUsdc
    ? formatUsdc(chainSnapshot.quoteUsdc)
    : selectedMilestone?.status === "approved"
      ? "Quote loading"
      : "After approval";

  return (
    <main className="shell">
      <header className="app-chrome" aria-label="Milestone PayFi app">
        <div className="brand-cluster">
          <div className="brand-mark">
            <CircleDollarSign size={18} aria-hidden="true" />
          </div>
          <div>
            <strong>Milestone PayFi</strong>
            <span>Approved work becomes instant working capital.</span>
          </div>
        </div>
        <div className="room-context">
          <span>Payment room</span>
          <strong>{selectedContract ? selectedContract.title : isLoading ? "Loading rooms" : "No room selected"}</strong>
        </div>
        <div className="chrome-actions">
          <button className="icon-button" onClick={loadContracts} aria-label="Refresh rooms" type="button">
            <RefreshCcw size={17} aria-hidden="true" />
          </button>
          {isConnected ? (
            <>
              <span className={wrongNetwork ? "network-pill warning" : "network-pill ok"}>
                {wrongNetwork ? "Switch to Arc" : "Arc verified"} {shortAddress(address)}
              </span>
              {wrongNetwork && (
                <button className="secondary-small" onClick={switchToArc} type="button">
                  Switch
                </button>
              )}
              <button className="secondary-small" onClick={() => disconnect()} type="button">
                Disconnect
              </button>
            </>
          ) : (
            <button className="primary-compact" onClick={connectWallet} disabled={isConnecting} type="button">
              {isConnecting ? "Connecting..." : "Connect wallet"}
            </button>
          )}
        </div>
      </header>

      {syncMessage && (
        <section className="success-panel">
          <CheckCircle2 size={18} aria-hidden="true" />
          <p>{syncMessage}</p>
        </section>
      )}

      {!configured && (
        <section className="warning-panel">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>Contracts must be deployed before real funding works.</strong>
            <p>
              Set `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_ESCROW_ADDRESS`, and
              `NEXT_PUBLIC_POOL_ADDRESS`, then restart the app. The task room and API work now; wallet
              transaction buttons are intentionally blocked until live addresses exist.
            </p>
          </div>
        </section>
      )}

      {error && (
        <section className="warning-panel error-panel">
          <AlertTriangle size={20} aria-hidden="true" />
          <p>{error}</p>
        </section>
      )}

      <section className="room-hero" aria-label="Payment room overview">
        <div className="room-copy">
          <span className="room-kicker">Protected work payment</span>
          <h1>{roomTitle}</h1>
          <p>{roomSubtitle}</p>
          <div className="quick-facts" aria-label="Room payment facts">
            <div>
              <span>Protected</span>
              <strong>{currentAmount}</strong>
            </div>
            <div>
              <span>Pay-now</span>
              <strong>{payNowValue}</strong>
            </div>
            <div>
              <span>Release</span>
              <strong>{selectedMilestone ? friendlyDate(selectedMilestone.releaseAt) : "Set in room"}</strong>
            </div>
          </div>
        </div>
        <div className="hero-actions">
          <button className="primary-action" onClick={() => setComposerOpen(true)} type="button">
            <Plus size={18} aria-hidden="true" />
            New room
          </button>
          <button className="secondary-action" onClick={loadJudgeDemo} type="button">
            <Play size={17} aria-hidden="true" />
            Use demo room
          </button>
        </div>
      </section>

      {composerOpen && (
        <section className="composer-card" aria-label="Create protected payment room">
          <div className="composer-heading">
            <div>
              <span>Room setup</span>
              <h2>Create a protected task room</h2>
              <p>One milestone, two participants, funded USDC escrow, and a pay-now path after approval.</p>
            </div>
            <button className="icon-button" onClick={() => setComposerOpen(false)} aria-label="Close room setup" type="button">
              X
            </button>
          </div>

          <form className="composer-form" onSubmit={createContract}>
            <div className="composer-steps">
              <section className="composer-step">
                <div className="step-index">1</div>
                <div>
                  <h3>Work details</h3>
                  <div className="form-grid">
                    <label>
                      Task title
                      <input
                        value={form.title}
                        onChange={(event) => updateField("title", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.title)}
                      />
                      <FieldError message={fieldErrors.title} />
                    </label>
                    <label>
                      Amount USDC
                      <input
                        value={form.amountUsdc}
                        onChange={(event) => updateField("amountUsdc", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.amountUsdc)}
                      />
                      <FieldError message={fieldErrors.amountUsdc} />
                    </label>
                    <label className="wide">
                      Summary
                      <textarea
                        value={form.summary}
                        onChange={(event) => updateField("summary", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.summary)}
                        rows={2}
                      />
                      <FieldError message={fieldErrors.summary} />
                    </label>
                    <label className="wide">
                      Deliverable
                      <textarea
                        value={form.deliverable}
                        onChange={(event) => updateField("deliverable", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.deliverable)}
                        rows={3}
                      />
                      <FieldError message={fieldErrors.deliverable} />
                    </label>
                  </div>
                </div>
              </section>

              <section className="composer-step">
                <div className="step-index">2</div>
                <div>
                  <h3>People and wallets</h3>
                  <div className="form-grid">
                    <label>
                      Client name
                      <input
                        value={form.clientName}
                        onChange={(event) => updateField("clientName", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.clientName)}
                      />
                      <FieldError message={fieldErrors.clientName} />
                    </label>
                    <label>
                      Client email
                      <input
                        value={form.clientEmail}
                        onChange={(event) => updateField("clientEmail", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.clientEmail)}
                      />
                      <FieldError message={fieldErrors.clientEmail} />
                    </label>
                    <label className="wide">
                      Client wallet
                      <input
                        value={form.clientAddress}
                        placeholder="0x..."
                        onChange={(event) => updateField("clientAddress", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.clientAddress)}
                      />
                      <FieldError message={fieldErrors.clientAddress} />
                    </label>
                    <label>
                      Freelancer name
                      <input
                        value={form.freelancerName}
                        onChange={(event) => updateField("freelancerName", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.freelancerName)}
                      />
                      <FieldError message={fieldErrors.freelancerName} />
                    </label>
                    <label>
                      Freelancer email
                      <input
                        value={form.freelancerEmail}
                        onChange={(event) => updateField("freelancerEmail", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.freelancerEmail)}
                      />
                      <FieldError message={fieldErrors.freelancerEmail} />
                    </label>
                    <label className="wide">
                      Freelancer wallet
                      <input
                        value={form.freelancerAddress}
                        placeholder="0x..."
                        onChange={(event) => updateField("freelancerAddress", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.freelancerAddress)}
                      />
                      <FieldError message={fieldErrors.freelancerAddress} />
                    </label>
                  </div>
                </div>
              </section>

              <section className="composer-step">
                <div className="step-index">3</div>
                <div>
                  <h3>Release plan</h3>
                  <div className="form-grid">
                    <label>
                      Release time
                      <input
                        type="datetime-local"
                        value={form.releaseAtLocal}
                        onChange={(event) => updateField("releaseAtLocal", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.releaseAtLocal || fieldErrors.releaseAt)}
                      />
                      <FieldError message={fieldErrors.releaseAtLocal || fieldErrors.releaseAt} />
                    </label>
                    <label>
                      Creator role
                      <select
                        value={form.creatorRole}
                        onChange={(event) =>
                          updateField("creatorRole", event.target.value as FormState["creatorRole"])
                        }
                        aria-invalid={Boolean(fieldErrors.creatorRole)}
                      >
                        <option value="client">Client creates task</option>
                        <option value="freelancer">Freelancer creates task</option>
                      </select>
                      <FieldError message={fieldErrors.creatorRole} />
                    </label>
                    <label className="wide">
                      Milestone title
                      <input
                        value={form.milestoneTitle}
                        onChange={(event) => updateField("milestoneTitle", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.milestoneTitle)}
                      />
                      <FieldError message={fieldErrors.milestoneTitle} />
                    </label>
                  </div>
                </div>
              </section>
            </div>

            <button className="primary-action" disabled={isCreating}>
              {isCreating ? "Creating..." : "Create task room"}
            </button>
          </form>
        </section>
      )}

      <section className="payment-room-layout">
        <div className="room-stack">
          <div className="room-toolbar">
            <div className="segmented-control" aria-label="View room as">
              {(["client", "freelancer", "liquidity"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  className={viewMode === mode ? "active" : ""}
                  onClick={() => setViewMode(mode)}
                  type="button"
                >
                  {mode === "client" ? "Client" : mode === "freelancer" ? "Freelancer" : "Liquidity"}
                </button>
              ))}
            </div>
            {selectedContract && (
              <button
                className="secondary-small"
                onClick={() => navigator.clipboard.writeText(`${window.location.origin}/?contract=${selectedContract.id}`)}
                type="button"
              >
                Copy link
              </button>
            )}
          </div>

          <JourneyRail milestone={selectedMilestone} />

          <RoleNarrative viewMode={viewMode} roleForWallet={roleForWallet} />

          {selectedContract && selectedMilestone ? (
            <article className={`milestone room-card ${selectedMilestone.status}`} aria-label="Selected payment room">
              <div className="room-card-header">
                <div>
                  <span className="status-pill">{statusCopy[selectedMilestone.status]}</span>
                  <h2>{selectedMilestone.title}</h2>
                </div>
                <div className="amount-lockup">
                  <span>Protected</span>
                  <strong>{formatUsdc(selectedMilestone.amountUsdc)}</strong>
                </div>
              </div>

              <p className="room-description">{selectedMilestone.deliverable}</p>

              <div className="party-row">
                <div>
                  <span>Client</span>
                  <strong>{selectedContract.clientName}</strong>
                  <small>{shortAddress(selectedContract.clientAddress)}</small>
                </div>
                <ArrowRight size={18} aria-hidden="true" />
                <div>
                  <span>Freelancer</span>
                  <strong>{selectedContract.freelancerName}</strong>
                  <small>{shortAddress(selectedContract.freelancerAddress)}</small>
                </div>
              </div>

              <div className="room-facts">
                <div>
                  <Banknote size={17} aria-hidden="true" />
                  <span>Escrow funded</span>
                  <strong>{formatUsdc(totals.funded)}</strong>
                </div>
                <div>
                  <Zap size={17} aria-hidden="true" />
                  <span>Pay-now quote</span>
                  <strong>{payNowValue}</strong>
                </div>
                <div>
                  <FileClock size={17} aria-hidden="true" />
                  <span>Release</span>
                  <strong>{friendlyDate(selectedMilestone.releaseAt)}</strong>
                </div>
                <div>
                  <ReceiptText size={17} aria-hidden="true" />
                  <span>Proof</span>
                  <strong>{selectedMilestone.onchainId ? `Milestone #${selectedMilestone.onchainId}` : "Not onchain yet"}</strong>
                </div>
              </div>

              {selectedMilestone.submissionNote && (
                <div className="note">
                  <strong>Submitted work</strong>
                  <p>{selectedMilestone.submissionNote}</p>
                  {selectedMilestone.submissionUrl && (
                    <a href={selectedMilestone.submissionUrl} target="_blank" rel="noreferrer">
                      Open work link <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </article>
          ) : (
            <div className="empty-state">
              <strong>No payment room yet</strong>
              <p>Create a room to protect the milestone and unlock pay-now after approval.</p>
              <button className="primary-action" onClick={() => setComposerOpen(true)} type="button">
                New room
              </button>
            </div>
          )}

          {contracts.length > 0 && (
            <details className="details-panel room-list-panel">
              <summary>
                <span>Other payment rooms</span>
                <BriefcaseBusiness size={17} aria-hidden="true" />
              </summary>
              <ContractList contracts={contracts} selectedId={selectedContract?.id} onSelect={setSelectedId} />
            </details>
          )}
        </div>

        <aside className="side-column" aria-label="Payment room actions">
          <section className="next-action-card">
            <div className="section-heading compact">
              <div>
                <span className="section-label">Next action</span>
                <h2>{roleForWallet === "both" ? "Client and freelancer" : roleForWallet ?? "Connect wallet"}</h2>
              </div>
              <WalletCards size={20} aria-hidden="true" />
            </div>
            <p>
              Milestone PayFi only enables the action assigned to the connected participant wallet.
            </p>
            {selectedContract && selectedMilestone ? (
              <>
                <RiskPolicyPanel
                  milestone={selectedMilestone}
                  review={riskReview}
                  snapshot={chainSnapshot}
                  isPoolOwner={isPoolOwner}
                  onPublish={() =>
                    riskReview &&
                    sendContractTx("Publishing risk policy", () =>
                      publishRiskPolicy(selectedContract, selectedMilestone, riskReview).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  disabled={Boolean(pendingLabel) || !configured || !isConnected || wrongNetwork}
                />
                <MilestoneActions
                  milestone={selectedMilestone}
                  roleForWallet={roleForWallet}
                  disabled={Boolean(pendingLabel) || !configured || !isConnected || wrongNetwork}
                  advanceBlocked={
                    selectedMilestone.status === "approved" &&
                    (!chainSnapshot?.riskPolicySupported ||
                      !chainSnapshot.riskPolicyPublished ||
                      Boolean(riskReview?.hardBlock))
                  }
                  onCreate={() =>
                    sendContractTx("Creating onchain milestone", () =>
                      createOnchain(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onApproveUsdc={() =>
                    sendContractTx("Approving USDC", () =>
                      approveUsdc(selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onFund={() =>
                    sendContractTx("Funding escrow", () =>
                      fundEscrow(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onSubmit={() =>
                    sendContractTx("Submitting work onchain", () =>
                      submitWork(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onApprove={() =>
                    sendContractTx("Approving milestone", () =>
                      approveWork(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onAdvance={() =>
                    sendContractTx("Requesting early payout", () =>
                      takeAdvance(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onRelease={() =>
                    sendContractTx("Releasing payout", () =>
                      release(selectedContract, selectedMilestone).then(() => ({ hash: "0x" as Hex }))
                    )
                  }
                  onSync={syncSelectedFromChain}
                />
                {pendingLabel && <p className="pending-line">{pendingLabel}. Confirm in wallet and wait for Arc confirmation.</p>}
              </>
            ) : (
              <button className="primary-action" onClick={() => setComposerOpen(true)} type="button">
                New room
              </button>
            )}
            <a className="external-link" href={ARC_FAUCET_URL} target="_blank" rel="noreferrer">
              Get Arc Testnet USDC <ExternalLink size={14} aria-hidden="true" />
            </a>
          </section>

          <section className="action-panel">
            <div className="section-heading compact">
              <div>
                <span className="section-label">Submit work</span>
                <h2>Freelancer evidence</h2>
              </div>
              <FileCheck2 size={20} aria-hidden="true" />
            </div>
            <label className="submission-box">
              <span>Submission note</span>
              <textarea value={submissionNote} onChange={(event) => setSubmissionNote(event.target.value)} rows={4} />
            </label>
            <label className="submission-box">
              <span>Work URL</span>
              <input value={submissionUrl} onChange={(event) => setSubmissionUrl(event.target.value)} placeholder="https://..." />
            </label>
          </section>

          <PoolPanel snapshot={chainSnapshot} milestone={selectedMilestone} />

          <AgentPanel contract={selectedContract} milestone={selectedMilestone} snapshot={chainSnapshot} />

          <details className="details-panel">
            <summary>
              <span>Funding readiness</span>
              <Banknote size={17} aria-hidden="true" />
            </summary>
            <FundingReadiness
              connected={isConnected}
              wrongNetwork={wrongNetwork}
              milestone={selectedMilestone}
              snapshot={chainSnapshot}
            />
          </details>

          <details className="details-panel">
            <summary>
              <span>Fund from any chain</span>
              <Layers3 size={17} aria-hidden="true" />
            </summary>
            <BridgePanel />
          </details>

          <details className="details-panel proof-details" open>
            <summary>
              <span>Verified on Arc</span>
              <ShieldCheck size={17} aria-hidden="true" />
            </summary>
            <button
              className="secondary-small full"
              onClick={syncSelectedFromChain}
              disabled={!selectedContract || isSyncing}
              type="button"
            >
              <RefreshCcw size={15} aria-hidden="true" />
              {isSyncing ? "Syncing..." : "Sync proof"}
            </button>
            <ProofPanel contract={selectedContract} milestone={selectedMilestone} />
          </details>

          <details className="details-panel">
            <summary>
              <span>Receipt history</span>
              <History size={17} aria-hidden="true" />
            </summary>
            <div className="events">
              {selectedContract?.receipts.map((receipt) => (
                <div className="event" key={receipt.id}>
                  <span>{shortAddress(receipt.actorAddress)}</span>
                  <p>{receipt.label}</p>
                  <small>{new Date(receipt.createdAt).toLocaleString()}</small>
                  {receipt.txHash && (
                    <a href={arcTxUrl(receipt.txHash)} target="_blank" rel="noreferrer">
                      {shortAddress(receipt.txHash)}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </details>
        </aside>
      </section>

      <section className="outcome-strip">
        <div>
          <BadgeCheck size={19} aria-hidden="true" />
          <span>Activation</span>
          <strong>Client protects the payment</strong>
        </div>
        <div>
          <Send size={19} aria-hidden="true" />
          <span>PMF signal</span>
          <strong>Freelancer chooses pay-now</strong>
        </div>
        <div>
          <ShieldCheck size={19} aria-hidden="true" />
          <span>Arc proof</span>
          <strong>Escrow repays the pool</strong>
        </div>
      </section>

      <footer className="footer-note">
        Contract addresses: escrow{" "}
        {deployment.escrow ? (
          <a href={arcAddressUrl(deployment.escrow)} target="_blank" rel="noreferrer">
            {shortAddress(deployment.escrow)}
          </a>
        ) : (
          "not set"
        )}{" "}
        · pool{" "}
        {deployment.pool ? (
          <a href={arcAddressUrl(deployment.pool)} target="_blank" rel="noreferrer">
            {shortAddress(deployment.pool)}
          </a>
        ) : (
          "not set"
        )}
      </footer>
    </main>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <small className="field-error">{message}</small>;
}

function JourneyRail({ milestone }: { milestone: Milestone | null }) {
  const activeRank = milestone ? statusRank[milestone.status] : 0;

  return (
    <section className="journey-rail" aria-label="Milestone settlement journey">
      {journeySteps.map((step) => {
        const complete = activeRank >= statusRank[step.status];
        const active = milestone?.status === step.status;
        return (
          <div className={`${complete ? "complete" : ""} ${active ? "active" : ""}`} key={step.status}>
            <span>{complete ? <CheckCircle2 size={15} aria-hidden="true" /> : <FileClock size={15} aria-hidden="true" />}</span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </div>
        );
      })}
    </section>
  );
}

function RoleNarrative({
  viewMode,
  roleForWallet
}: {
  viewMode: ViewMode;
  roleForWallet: string | null;
}) {
  const copy = {
    client: {
      icon: <ShieldCheck size={18} aria-hidden="true" />,
      title: "Client view",
      body: "Fund escrow first, approve only accepted work, and keep an onchain receipt for each settlement step."
    },
    freelancer: {
      icon: <Users size={18} aria-hidden="true" />,
      title: "Freelancer view",
      body: "Submit evidence, wait for approval, then convert the funded receivable into immediate USDC."
    },
    liquidity: {
      icon: <Coins size={18} aria-hidden="true" />,
      title: "Liquidity view",
      body: "Pool capital advances approved receivables and is repaid from escrow when the milestone reaches its release time."
    }
  }[viewMode];

  return (
    <section className="role-narrative">
      <div>{copy.icon}</div>
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
      <span>{roleForWallet === "both" ? "Demo wallet controls both roles" : roleForWallet ?? "Wallet disconnected"}</span>
    </section>
  );
}

function FundingReadiness({
  connected,
  wrongNetwork,
  milestone,
  snapshot
}: {
  connected: boolean;
  wrongNetwork: boolean;
  milestone: Milestone | null;
  snapshot: ChainSnapshot | null;
}) {
  const amount = Number(milestone?.amountUsdc ?? 0);
  const walletBalance = Number(snapshot?.walletBalanceUsdc ?? 0);
  const allowance = Number(snapshot?.escrowAllowanceUsdc ?? 0);
  const checks = [
    {
      label: "Wallet connected",
      ok: connected && !wrongNetwork,
      value: connected ? (wrongNetwork ? "Wrong network" : "Ready") : "Disconnected"
    },
    {
      label: "USDC balance",
      ok: Boolean(snapshot?.walletBalanceUsdc) && walletBalance >= amount,
      value: snapshot?.walletBalanceUsdc ? formatUsdc(snapshot.walletBalanceUsdc) : "Unknown"
    },
    {
      label: "Escrow allowance",
      ok: Boolean(snapshot?.escrowAllowanceUsdc) && allowance >= amount,
      value: snapshot?.escrowAllowanceUsdc ? formatUsdc(snapshot.escrowAllowanceUsdc) : "Approve before funding"
    }
  ];

  return (
    <section className="action-panel readiness-panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Funding readiness</p>
          <h2>USDC path</h2>
        </div>
        <Banknote size={20} aria-hidden="true" />
      </div>
      <div className="readiness-list">
        {checks.map((check) => (
          <div className={check.ok ? "ok" : ""} key={check.label}>
            <span>{check.ok ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}</span>
            <strong>{check.label}</strong>
            <small>{check.value}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function PoolPanel({
  snapshot,
  milestone
}: {
  snapshot: ChainSnapshot | null;
  milestone: Milestone | null;
}) {
  return (
    <section className="action-panel pool-intel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Pay-now pool</p>
          <h2>Receivable quote</h2>
        </div>
        <Layers3 size={20} aria-hidden="true" />
      </div>
      <div className="quote-card">
        <span>{milestone?.status === "approved" ? "Live advance" : "Advance unlocks after approval"}</span>
        <strong>{snapshot?.quoteUsdc ? formatUsdc(snapshot.quoteUsdc) : "No quote yet"}</strong>
        <small>
          {snapshot?.quoteDiscountBps
            ? `${(snapshot.quoteDiscountBps / 100).toFixed(2)}% discount`
            : "Quote reads directly from the pool contract."}
        </small>
      </div>
      <div className="pool-grid">
        <div>
          <span>Available</span>
          <strong>{snapshot ? formatUsdc(snapshot.availableUsdc) : "Unknown"}</strong>
        </div>
        <div>
          <span>Outstanding</span>
          <strong>{snapshot ? formatUsdc(snapshot.outstandingUsdc) : "Unknown"}</strong>
        </div>
        <div>
          <span>Max advance</span>
          <strong>{snapshot ? formatUsdc(snapshot.maxAdvanceUsdc) : "Unknown"}</strong>
        </div>
        <div>
          <span>Utilization cap</span>
          <strong>{snapshot ? `${snapshot.utilizationCapBps / 100}%` : "Unknown"}</strong>
        </div>
        <div>
          <span>Client cap</span>
          <strong>{snapshot?.clientExposureCapUsdc ? formatUsdc(snapshot.clientExposureCapUsdc) : "Unknown"}</strong>
        </div>
        <div>
          <span>Freelancer cap</span>
          <strong>{snapshot?.freelancerExposureCapUsdc ? formatUsdc(snapshot.freelancerExposureCapUsdc) : "Unknown"}</strong>
        </div>
      </div>
      {snapshot?.annualizedDiscountBps !== null && snapshot && (
        <p className="small-muted">
          Pricing: {(snapshot.baseDiscountBps / 100).toFixed(2)}% base plus time-to-maturity,
          capped at {(snapshot.maxDiscountBps / 100).toFixed(2)}%.
        </p>
      )}
      <p className="small-muted">
        LP disclosure: advances are risk-gated but not guaranteed yield. Withdrawals require idle pool liquidity;
        outstanding receivables must settle before that capital can exit. Arc Testnet only.
      </p>
      {snapshot?.paused && <p className="field-error">Pool is paused.</p>}
    </section>
  );
}

function AgentPanel({
  contract,
  milestone,
  snapshot
}: {
  contract: WorkContract | null;
  milestone: Milestone | null;
  snapshot: ChainSnapshot | null;
}) {
  const underwriter = deployment.underwriter;
  if (!contract || !milestone) return null;

  const isAgentActor = (actor: string) =>
    actor.toLowerCase() !== contract.clientAddress.toLowerCase() &&
    actor.toLowerCase() !== contract.freelancerAddress.toLowerCase();

  const agentReceipts = contract.receipts
    .filter((receipt) => isAgentActor(receipt.actorAddress) && receipt.txHash)
    .slice(0, 3);

  const policyByAgent = Boolean(
    snapshot?.riskPolicyPublished &&
      contract.receipts.some(
        (receipt) =>
          receipt.type === "risk_reviewed" &&
          underwriter &&
          receipt.actorAddress.toLowerCase() === underwriter.toLowerCase()
      )
  );

  const awaitingAgent =
    milestone.status === "approved" && snapshot?.riskPolicySupported && !snapshot.riskPolicyPublished;

  return (
    <section className="action-panel agent-panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Agentic layer</p>
          <h2>Underwriter agent</h2>
        </div>
        <Bot size={20} aria-hidden="true" />
      </div>
      <p className="small-muted">
        Risk scoring, policy publication, and settlement run autonomously on Arc — no human in the loop.
      </p>
      <div className="proof-list">
        <ProofRow
          label="Agent"
          value={underwriter ? shortAddress(underwriter) : "Not delegated"}
          href={underwriter ? arcAddressUrl(underwriter) : undefined}
        />
        <ProofRow
          label="Identity"
          value={underwriter ? "ERC-8004 on Arc" : "Pending registration"}
          href={underwriter ? arcAddressUrl(underwriter) : undefined}
        />
      </div>
      {policyByAgent && <p className="agent-status ok">Policy published autonomously by the agent.</p>}
      {awaitingAgent && (
        <p className="agent-status">Approved receivable detected — the agent scores and publishes the policy.</p>
      )}
      {!underwriter && (
        <p className="quiet-action">Set NEXT_PUBLIC_UNDERWRITER_ADDRESS after deploying with UNDERWRITER_ADDRESS.</p>
      )}
      {agentReceipts.length > 0 && (
        <div className="events agent-events">
          {agentReceipts.map((receipt) => (
            <div className="event" key={receipt.id}>
              <span>{receipt.type === "risk_reviewed" ? "Underwriter" : "Settler"}</span>
              <p>{receipt.label}</p>
              {receipt.txHash && (
                <a href={arcTxUrl(receipt.txHash)} target="_blank" rel="noreferrer">
                  {shortAddress(receipt.txHash)}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RiskPolicyPanel({
  milestone,
  review,
  snapshot,
  isPoolOwner,
  disabled,
  onPublish
}: {
  milestone: Milestone | null;
  review: RiskReview | null;
  snapshot: ChainSnapshot | null;
  isPoolOwner: boolean;
  disabled: boolean;
  onPublish: () => void;
}) {
  if (!milestone) return null;
  const show = milestone.status === "approved" || milestone.status === "early_paid" || Boolean(milestone.riskReview);
  if (!show) return null;

  const publishedReview = milestone.riskReview;
  const activeReview = publishedReview ?? review;
  if (!activeReview) return null;

  return (
    <section className="action-panel risk-panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Pool risk policy</p>
          <h2 className={`tier-${activeReview.tier.toLowerCase()}`}>Tier {activeReview.tier}</h2>
        </div>
        <ShieldCheck size={20} aria-hidden="true" />
      </div>
      <div className="pool-grid">
        <div>
          <span>Score</span>
          <strong>{activeReview.score}/100</strong>
        </div>
        <div>
          <span>Max advance</span>
          <strong>{(activeReview.maxAdvanceBps / 100).toFixed(0)}%</strong>
        </div>
        <div>
          <span>Base discount</span>
          <strong>{(activeReview.baseDiscountBps / 100).toFixed(2)}%</strong>
        </div>
        <div>
          <span>Max discount</span>
          <strong>{(activeReview.maxDiscountBps / 100).toFixed(2)}%</strong>
        </div>
      </div>
      {activeReview.flags.length > 0 ? (
        <ul className="risk-flags">
          {activeReview.flags.map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
      ) : (
        <p className="small-muted">No hard fraud flags detected by the demo risk model.</p>
      )}
      {snapshot?.riskPolicySupported === false && (
        <p className="field-error">Current pool is v1. Redeploy v2 before risk-gated advances are live.</p>
      )}
      {snapshot?.riskPolicySupported && snapshot.riskPolicyPublished && (
        <p className="small-muted">Published on Arc: {shortAddress(snapshot.riskPolicy?.riskHash)}</p>
      )}
      {snapshot?.riskPolicySupported && !snapshot.riskPolicyPublished && (
        <>
          <button
            className="secondary-action"
            disabled={disabled || !isPoolOwner || activeReview.hardBlock}
            onClick={onPublish}
            type="button"
          >
            Publish risk policy
          </button>
          {!isPoolOwner && (
            <p className="quiet-action">
              Published autonomously by the delegated underwriter agent, or manually by the pool owner.
            </p>
          )}
          {activeReview.hardBlock && <p className="field-error">This receivable is blocked from early payout.</p>}
        </>
      )}
    </section>
  );
}

function ProofPanel({
  contract,
  milestone
}: {
  contract: WorkContract | null;
  milestone: Milestone | null;
}) {
  const latestTx = contract?.receipts.find((receipt) => receipt.txHash)?.txHash;

  return (
    <section className="action-panel proof-panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Onchain proof</p>
          <h2>Arc receipts</h2>
        </div>
        <ClipboardCheck size={20} aria-hidden="true" />
      </div>
      <div className="proof-list">
        <ProofRow label="Escrow" value={shortAddress(contract?.escrowAddress)} href={arcAddressUrl(contract?.escrowAddress)} />
        <ProofRow label="Pool" value={shortAddress(contract?.poolAddress)} href={arcAddressUrl(contract?.poolAddress)} />
        <ProofRow label="Milestone" value={milestone?.onchainId ? `#${milestone.onchainId}` : "Not created"} />
        <ProofRow label="Latest tx" value={latestTx ? shortAddress(latestTx) : "No tx yet"} href={arcTxUrl(latestTx)} />
      </div>
    </section>
  );
}

function ProofRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <span>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {value} <Link2 size={13} aria-hidden="true" />
        </a>
      ) : (
        <strong>{value}</strong>
      )}
    </div>
  );
}

function ContractList({
  contracts,
  selectedId,
  onSelect
}: {
  contracts: WorkContract[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  if (contracts.length === 0) return null;

  return (
    <div className="contract-list">
      {contracts.map((contract) => (
        <button
          className={contract.id === selectedId ? "active" : ""}
          key={contract.id}
          onClick={() => onSelect(contract.id)}
        >
          <strong>{contract.title}</strong>
          <span>{contract.milestones[0]?.status ? statusCopy[contract.milestones[0].status] : "Draft"}</span>
        </button>
      ))}
    </div>
  );
}

function MilestoneActions({
  milestone,
  roleForWallet,
  disabled,
  advanceBlocked,
  onCreate,
  onApproveUsdc,
  onFund,
  onSubmit,
  onApprove,
  onAdvance,
  onRelease,
  onSync
}: {
  milestone: Milestone;
  roleForWallet: string | null;
  disabled: boolean;
  advanceBlocked?: boolean;
  onCreate: () => void;
  onApproveUsdc: () => void;
  onFund: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  onAdvance: () => void;
  onRelease: () => void;
  onSync?: () => void;
}) {
  const isClient = roleForWallet === "client" || roleForWallet === "both";
  const isFreelancer = roleForWallet === "freelancer" || roleForWallet === "both";
  const isParticipant = isClient || isFreelancer;
  const roleHint =
    roleForWallet === "viewer"
      ? "Connected wallet is not a participant in this task."
      : "Connect as the client or freelancer wallet to act.";

  if (milestone.status === "draft") {
    return (
      <>
        <button className="primary-action" disabled={disabled || !isParticipant} onClick={onCreate}>
          Create onchain milestone
        </button>
        {!isParticipant && <p className="quiet-action">{roleHint}</p>}
      </>
    );
  }

  if (milestone.status === "created_onchain") {
    return (
      <>
        <div className="action-row">
          <button className="secondary-action" disabled={disabled || !isClient} onClick={onApproveUsdc}>
            Approve USDC
          </button>
          <button className="primary-action" disabled={disabled || !isClient} onClick={onFund}>
            Fund escrow
          </button>
        </div>
        {!isClient && <p className="quiet-action">Client wallet must approve and fund this milestone.</p>}
      </>
    );
  }

  if (milestone.status === "funded") {
    return (
      <>
        <button className="primary-action" disabled={disabled || !isFreelancer} onClick={onSubmit}>
          Submit work onchain
        </button>
        {!isFreelancer && <p className="quiet-action">Freelancer wallet must submit work evidence.</p>}
      </>
    );
  }

  if (milestone.status === "submitted") {
    return (
      <>
        <button className="primary-action" disabled={disabled || !isClient} onClick={onApprove}>
          Approve receivable
        </button>
        {!isClient && <p className="quiet-action">Client wallet must approve the receivable.</p>}
      </>
    );
  }

  if (milestone.status === "approved") {
    return (
      <>
        <div className="action-row">
          <button className="primary-action" disabled={disabled || advanceBlocked || !isFreelancer} onClick={onAdvance}>
            Request early payout
          </button>
          <button className="secondary-action" disabled={disabled || !isParticipant} onClick={onRelease}>
            Release scheduled payout
          </button>
        </div>
        {advanceBlocked && isFreelancer && (
          <p className="quiet-action">
            Advance locked — risk policy not yet published onchain. The underwriter agent will score and
            publish it, then{" "}
            <button className="inline-action" type="button" onClick={onSync}>
              Sync proof
            </button>{" "}
            to refresh.
          </p>
        )}
        {!isParticipant && <p className="quiet-action">{roleHint}</p>}
      </>
    );
  }

  if (milestone.status === "early_paid") {
    return (
      <>
        <button className="secondary-action" disabled={disabled || !isParticipant} onClick={onRelease}>
          Settle pool repayment
        </button>
        {!isParticipant && <p className="quiet-action">Client or freelancer wallet can trigger escrow repayment after the due time.</p>}
      </>
    );
  }

  return <p className="quiet-action">No action available for this wallet at the current milestone state.</p>;
}
