import {
  AlertTriangle,
  CircleCheck,
  Clock,
  CreditCard,
  Gift,
  KeyRound,
  ShieldAlert,
  UserX,
  type LucideIcon,
} from "lucide-react";
import type { TacticValue } from "./schema";

type TacticMeta = { label: string; icon: LucideIcon; weight: number; definition: string };

export const TACTIC_META: { [K in TacticValue]: TacticMeta } = {
  urgency: { label: "Urgency", icon: Clock, weight: 2, definition: "Manufactures a deadline so you can't think or verify." },
  authority_impersonation: { label: "False Authority", icon: ShieldAlert, weight: 2, definition: "Borrows the credibility of an agency, bank, or company." },
  isolation: { label: "Isolation", icon: UserX, weight: 4, definition: "Keeps you from consulting family, friends, or officials." },
  threat: { label: "Threat", icon: AlertTriangle, weight: 4, definition: "Uses fear of arrest, lockout, or loss to force compliance." },
  too_good_to_be_true: { label: "Too Good To Be True", icon: Gift, weight: 2, definition: "Dangles an unearned prize or return to lower your guard." },
  payment_request: { label: "Payment Request", icon: CreditCard, weight: 5, definition: "Demands money through hard-to-reverse channels." },
  personal_info_request: { label: "Credential Request", icon: KeyRound, weight: 4, definition: "Asks for codes, IDs, or remote access to your devices." },
  none: { label: "Clear", icon: CircleCheck, weight: 0, definition: "No coercive function detected." },
};