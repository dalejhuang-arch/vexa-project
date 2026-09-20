// data/examples.ts  (input text only. Results are always produced by the real analysis pipeline.)
export interface Example {
  id: string;
  label: string;
  tag: string;
  transcript: string;
}

export const examples: Example[] = [
  {
    id: "utility",
    label: "Utility Rebate Scam (FTC)",
    tag: "FTC ROBOCALL ADVISORY",
    transcript: `CALLER: This is an important message from the electric rebate department.
CALLER: Qualifying residents in your area are eligible to receive a rebate check of up to $350 on their upcoming energy bill.
CALLER: Due to recent state utility commission settlements, funds must be claimed within the next 48 hours.
CALLER: To verify your meter number and claim your check, press 1 now.
CALLER: Press 2 to be removed from this notification list.`,
  },
  {
    id: "fbi",
    label: "Debt Arrest Threat (FBI)",
    tag: "FBI CASE EVIDENCE",
    transcript: `CALLER: This is Chief Investigator Sharon Wright. Am I speaking with you?
VICTIM: Yes.
CALLER: Again, my name is Investigator Sharon Wright. I'm investigating a criminal complaint that has been forwarded to this office against you. We are proceeding against you legally.
VICTIM: But what is this? I don't understand.
CALLER: Prior to forwarding this to your local authorities and them issuing a warrant for your arrest, I wanted to contact you to find out your intentions.
VICTIM: I haven't done anything. What do you want from me?
CALLER: We require an immediate down payment of at least half the balance to avoid legal action.
VICTIM: How much is that?
CALLER: If we don't hear from you, the attorney will forward it for a warrant to be issued for your arrest.`,
  },
];