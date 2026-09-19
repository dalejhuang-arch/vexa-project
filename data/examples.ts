// data/examples.ts
import type { Analysis } from "@/lib/schema";

export interface Example {
  id: string;
  label: string;
  tag: string;
  transcript: string;
  result: Analysis;
}

export const examples: Example[] = [
  {
    id: "grandparent",
    label: "Emergency Bail Extraction",
    tag: "FBI IC3 ELDER FRAUD",
    transcript: `CALLER: Grandma? Please, can you hear me?
YOU: Who is this? Michael?
CALLER: Yes, it's Michael. Grandma, I'm in serious trouble. I was in an accident and someone was hurt. The police took me into custody.
YOU: Oh my God, Michael! Are you okay? Where are you?
CALLER: I have a broken jaw and a concussion, that's why my voice sounds different. Please, you can't tell Mom and Dad. If Dad finds out he'll disown me.
CALLER: The public defender says the court will release me right now if we put up ten thousand dollars emergency bail before 5 PM.
CALLER: I have Mr. Daniels from the county bond clerk office taking over the line right now.
CALLER: Ma'am, this is David Daniels, legal bondsman. Under state detention statute 44, your grandson will be transferred to county jail unless bail is satisfied within 45 minutes.
YOU: Can I pay with a debit card or cashier's check?
CALLER: No, the county automated clearing system is offline. You must purchase prepaid merchant voucher cards from Target or Walmart and transmit the security PINs immediately.
YOU: That sounds strange. I want to talk to his mother first.
CALLER: If you terminate this call, I will document judicial non-compliance and your grandson will be remanded to maximum security until Tuesday morning. Do not hang up this phone.`,
    result: {
      riskScore: 96,
      category: "Grandparent/Family Emergency Scam",
      verdict: "likely_scam",
      summary: "High-coercion extortion synthesizing emotional panic, voice distortion excuses, family isolation, and irreversible gift card bail demands under threat of maximum-security detention.",
      tacticCounts: {
        urgency: 3,
        authority_impersonation: 2,
        isolation: 2,
        threat: 2,
        too_good_to_be_true: 0,
        payment_request: 1,
        personal_info_request: 0,
      },
      segments: [
        {
          text: "CALLER: Grandma? Please, can you hear me?",
          speaker: "caller",
          tactic: "none",
          explanation: "Open-ended familial probe engineered to induce the victim to volunteer an identity.",
          counterAdvice: "Ask 'State your full legal name and date of birth' without offering family names.",
        },
        {
          text: "YOU: Who is this? Michael?",
          speaker: "recipient",
          tactic: "none",
          explanation: "Victim inadvertently supplies the target name.",
          counterAdvice: "Refuse to guess names.",
        },
        {
          text: "CALLER: Yes, it's Michael. Grandma, I'm in serious trouble. I was in an accident and someone was hurt. The police took me into custody.",
          speaker: "caller",
          tactic: "urgency",
          explanation: "Manufactures acute catastrophe to suppress rational risk assessment.",
          counterAdvice: "Hang up and telephone your relative on their known personal cell number immediately.",
        },
        {
          text: "CALLER: I have a broken jaw and a concussion, that's why my voice sounds different. Please, you can't tell Mom and Dad. If Dad finds out he'll disown me.",
          speaker: "caller",
          tactic: "isolation",
          explanation: "Explains acoustic/timbre anomalies and demands secrecy from trusted family contacts.",
          counterAdvice: "Inform the caller: 'I am conferring with his parents right now.'",
        },
        {
          text: "CALLER: The public defender says the court will release me right now if we put up ten thousand dollars emergency bail before 5 PM.",
          speaker: "caller",
          tactic: "urgency",
          explanation: "Imposes an artificial chronological deadline to prevent external verification.",
          counterAdvice: "Courts operate official public dockets. Ask for the court division and case docket number.",
        },
        {
          text: "CALLER: Ma'am, this is David Daniels, legal bondsman. Under state detention statute 44, your grandson will be transferred to county jail unless bail is satisfied within 45 minutes.",
          speaker: "caller",
          tactic: "authority_impersonation",
          explanation: "Impersonates a legal official invoking fabricated statutory codes.",
          counterAdvice: "Bail is posted exclusively at municipal court windows or licensed physical bond offices.",
        },
        {
          text: "CALLER: No, the county automated clearing system is offline. You must purchase prepaid merchant voucher cards from Target or Walmart and transmit the security PINs immediately.",
          speaker: "caller",
          tactic: "payment_request",
          explanation: "Demands non-traceable, irreversible prepaid cards—an unambiguous red-line indicator of fraud.",
          counterAdvice: "Terminate communication. No law enforcement agency or court accepts commercial gift cards.",
        },
        {
          text: "CALLER: If you terminate this call, I will document judicial non-compliance and your grandson will be remanded to maximum security until Tuesday morning. Do not hang up this phone.",
          speaker: "caller",
          tactic: "threat",
          explanation: "Uses coercive detention threats and live-call tethering to block external consultation.",
          counterAdvice: "Hang up immediately. Contact local municipal police dispatch.",
        },
      ],
      inputMode: "transcript",
    },
  },
  {
    id: "tech",
    label: "Remote Host Intrusion Extortion",
    tag: "CISA / FBI ADVISORY",
    transcript: `CALLER: Security dispatch, this is Marcus Vance, Tier-3 Network Security with the Windows Kernel Defender division.
YOU: Hello? What's going on?
CALLER: We have detected active malicious Trojan exfiltration originating from your IP subnet. Foreign command servers are downloading your financial cache.
CALLER: Look at your keyboard right now. Hold the Windows key and hit R, then type 'eventvwr.exe' and hit enter immediately.
YOU: Okay... wow, there are hundreds of red error flags and exclamation marks.
CALLER: Those are remote kernel rootkits. Your workstation is weaponized. If you don't remediate this right now, the network provider will terminate your broadband connection for illegal activity.
CALLER: I am initiating an encrypted remote desktop session. Go to AnyConnect-Support.click and grant administrative bypass.
YOU: Is there any cost to clean this up?
CALLER: The enterprise patch requires a one-time server licensing verification of $399. We need your debit card credentials and the one-time code texted to your phone to authenticate the repair.`,
    result: {
      riskScore: 94,
      category: "Tech Support Scam",
      verdict: "likely_scam",
      summary: "Classic social engineering vector weaponizing routine OS telemetry logs (Event Viewer) to induce panic, establish unauthorized remote administrative access, and harvest banking credentials.",
      tacticCounts: {
        urgency: 2,
        authority_impersonation: 2,
        isolation: 0,
        threat: 2,
        too_good_to_be_true: 0,
        payment_request: 1,
        personal_info_request: 2,
      },
      segments: [
        {
          text: "CALLER: Security dispatch, this is Marcus Vance, Tier-3 Network Security with the Windows Kernel Defender division.",
          speaker: "caller",
          tactic: "authority_impersonation",
          explanation: "Fabricates enterprise technical titles to simulate corporate security authority.",
          counterAdvice: "Microsoft and Apple never conduct unsolicited outbound security telephone calls.",
        },
        {
          text: "CALLER: We have detected active malicious Trojan exfiltration originating from your IP subnet. Foreign command servers are downloading your financial cache.",
          speaker: "caller",
          tactic: "threat",
          explanation: "Deploys technical jargon to fabricate an ongoing cyber catastrophe.",
          counterAdvice: "Disconnect your router from the wall if concerned; never accept incoming remediation calls.",
        },
        {
          text: "CALLER: Look at your keyboard right now. Hold the Windows key and hit R, then type 'eventvwr.exe' and hit enter immediately.",
          speaker: "caller",
          tactic: "authority_impersonation",
          explanation: "Weaponizes benign system error logs to trick non-technical users into perceiving compromise.",
          counterAdvice: "Standard operating systems log routine background events in Event Viewer every hour.",
        },
        {
          text: "CALLER: I am initiating an encrypted remote desktop session. Go to AnyConnect-Support.click and grant administrative bypass.",
          speaker: "caller",
          tactic: "personal_info_request",
          explanation: "Demands remote desktop control to install keystroke loggers and secondary backdoors.",
          counterAdvice: "Never grant remote access or execute browser scripts at the direction of an unsolicited caller.",
        },
        {
          text: "CALLER: The enterprise patch requires a one-time server licensing verification of $399. We need your debit card credentials and the one-time code texted to your phone to authenticate the repair.",
          speaker: "caller",
          tactic: "payment_request",
          explanation: "Attempts to intercept multi-factor authentication (MFA) OTP codes and bank credentials.",
          counterAdvice: "One-Time Passwords (OTPs) should never be shared with anyone over the telephone.",
        },
      ],
      inputMode: "transcript",
    },
  },
  {
    id: "irs",
    label: "Federal Warrant & Crypto Kiosk Diversion",
    tag: "FTC CONSUMER SENTINEL",
    transcript: `CALLER: Special Agent Raymond Croft, Department of Treasury Internal Revenue Investigation Bureau, ID number 8092-TX.
YOU: Why are you calling me?
CALLER: An unsealed federal grand jury indictment has been entered in the Southern District Court against your Social Security Number for money laundering and offshore tax evasion.
CALLER: Federal marshals have already been dispatched to execute a physical warrant at your residence within 90 minutes.
CALLER: Because this involves federal statutes, under 18 U.S. Code section 1505, you are barred from contacting legal counsel or your local bank branch until the lien is satisfied.
YOU: Oh God, this has to be a mistake! I haven't done anything illegal!
CALLER: We believe you are a victim of identity theft, but you must secure your liquid capital into the federal protective digital vault.
CALLER: Drive to your bank, withdraw your entire balance of $18,500 in physical cash. If the teller asks why, declare it is for property remodeling.
CALLER: You will proceed immediately to the certified federal deposit terminal at the Shell gas station on Main Street and feed the bills into the Bitcoin receiver while remaining on this line.`,
    result: {
      riskScore: 99,
      category: "Government Imposter Scam",
      verdict: "likely_scam",
      summary: "Aggressive federal imposter coercion weaponizing fabricated arrest warrants, federal obstruction gag orders, teller deception instructions, and cryptocurrency kiosk cash liquidation.",
      tacticCounts: {
        urgency: 2,
        authority_impersonation: 2,
        isolation: 2,
        threat: 2,
        too_good_to_be_true: 0,
        payment_request: 2,
        personal_info_request: 0,
      },
      segments: [
        {
          text: "CALLER: Special Agent Raymond Croft, Department of Treasury Internal Revenue Investigation Bureau, ID number 8092-TX.",
          speaker: "caller",
          tactic: "authority_impersonation",
          explanation: "Fabricates Treasury law enforcement credentials and badge numbers.",
          counterAdvice: "The IRS and Treasury initiate formal inquiries exclusively through the US Postal Service.",
        },
        {
          text: "CALLER: Federal marshals have already been dispatched to execute a physical warrant at your residence within 90 minutes.",
          speaker: "caller",
          tactic: "threat",
          explanation: "Threatens immediate armed physical arrest to trigger extreme compliance.",
          counterAdvice: "Law enforcement never provides advance telephonic warnings of criminal arrest warrants.",
        },
        {
          text: "CALLER: Because this involves federal statutes, under 18 U.S. Code section 1505, you are barred from contacting legal counsel or your local bank branch until the lien is satisfied.",
          speaker: "caller",
          tactic: "isolation",
          explanation: "Misquotes criminal code to isolate the victim from bank tellers who are trained to spot fraud.",
          counterAdvice: "No government agency can legally forbid you from speaking to an attorney or your bank.",
        },
        {
          text: "CALLER: Drive to your bank, withdraw your entire balance of $18,500 in physical cash. If the teller asks why, declare it is for property remodeling.",
          speaker: "caller",
          tactic: "payment_request",
          explanation: "Instructs the target to lie to financial institution personnel to evade anti-money laundering controls.",
          counterAdvice: "Tell your bank branch manager immediately: 'I am being pressured to withdraw cash by someone on the phone.'",
        },
        {
          text: "CALLER: You will proceed immediately to the certified federal deposit terminal at the Shell gas station on Main Street and feed the bills into the Bitcoin receiver while remaining on this line.",
          speaker: "caller",
          tactic: "payment_request",
          explanation: "Commands deposit into an anonymous cryptocurrency kiosk—an irreversible fraud funnel.",
          counterAdvice: "Governments never maintain or collect debts via commercial cryptocurrency ATMs.",
        },
      ],
      inputMode: "transcript",
    },
  },
];