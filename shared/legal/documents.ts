// The legal documents, as data.
//
// Held as structured data rather than JSX or Markdown for three reasons:
//   1. The clickwrap summary, the in-app reader and the acceptance hash all
//      need the same text. One source, no drift.
//   2. Every mention of the operator, forum, cap or version interpolates from
//      entity.ts, so no document can name the wrong counterparty.
//   3. A test can walk the whole tree and assert no placeholder ever renders
//      (legalcheck.md pre-ship checklist).
//
// ─── What is genuinely different about this product ───────────────────
//
// Krypto Bot is DOWNLOADABLE SOFTWARE WITH NO SERVER AND NO ACCOUNT. The
// operator runs no backend, so there is no place for user data to be collected
// and no session that could carry a site ToS. That makes the download-time
// clickwrap the only thing binding the user (legalcheck.md, "Downloadable
// software"), and it makes most of a conventional privacy policy inapplicable —
// which is stated plainly rather than padded out with clauses that describe
// nothing.
//
// It is also a TRADING tool that signs transactions with a real private key, so
// the financial clauses are not boilerplate here; they are the main event.

import {
  LEGAL_ENTITY,
  BRAND,
  PRODUCT_NAME,
  GOVERNING_LAW,
  VENUE,
  CONTACT_EMAIL,
  WEBSITE,
  ARBITRATION_FORUM,
  ARBITRATION_RULES,
  LIABILITY_CAP_USD,
  TERMS_EFFECTIVE_DATE,
  MINIMUM_AGE,
  ACCEPTANCE_RETENTION_DAYS,
} from './entity';
import { feePctLabel } from '../fees';

export interface LegalSection {
  heading: string;
  /** Paragraphs. Rendered in order. */
  body: string[];
  /** Rendered in caps/bold — the sections a court expects to see conspicuous. */
  emphasis?: boolean;
}

export interface LegalDocument {
  id: 'terms' | 'privacy' | 'software';
  title: string;
  subtitle: string;
  sections: LegalSection[];
}

const CAP = `US$${LIABILITY_CAP_USD}`;

// ══════════════════════════════════════════════════════════════════════
// 1. Terms of Service
// ══════════════════════════════════════════════════════════════════════

export const TERMS_OF_SERVICE: LegalDocument = {
  id: 'terms',
  title: 'Terms of Service',
  subtitle: `Last updated ${TERMS_EFFECTIVE_DATE}`,
  sections: [
    {
      heading: '1. Who you are agreeing with',
      body: [
        `${PRODUCT_NAME} is published by ${LEGAL_ENTITY}${
          LEGAL_ENTITY === BRAND ? '' : `, trading as ${BRAND}`
        } ("we", "us", "the operator"). These Terms govern your use of ${PRODUCT_NAME} and any related materials we publish.`,
        `You can reach us at ${CONTACT_EMAIL}. Our website is ${WEBSITE}.`,
        `${PRODUCT_NAME} is software you download and run on your own computer. We do not operate a server for it, we do not host your data, and there is no ${BRAND} account. Your copy runs entirely on your machine.`,
      ],
    },
    {
      heading: '2. Eligibility and age',
      body: [
        `You must be at least ${MINIMUM_AGE} years old to use ${PRODUCT_NAME}. This is deliberately higher than a general-purpose utility would require, because this software signs blockchain transactions that move real money and can lose all of it.`,
        'You must also be legally able to form a binding contract, and not barred from using this kind of software under the laws that apply to you.',
        'If you are using this on behalf of a company or other organisation, you confirm you are authorised to bind it, and "you" means that organisation.',
      ],
    },
    {
      heading: '3. No account',
      body: [
        `There is no registration, no login, and no ${BRAND} account. We do not issue credentials and we cannot recover anything for you.`,
        'The wallet keys the software holds are yours alone. We never receive them, cannot see them, and cannot restore them if you lose them. There is no password reset for a blockchain wallet.',
      ],
    },
    {
      heading: '4. Licence to use the software',
      body: [
        `We grant you a personal, non-exclusive, non-transferable, revocable licence to install and use ${PRODUCT_NAME} for your own use.`,
        'You may not sell, sublicense, rent, or redistribute the software as your own product, remove or alter attribution or notices, or present a modified build as an official release.',
        'Where any component is covered by its own open-source licence, that licence governs that component and prevails over this section to the extent of any conflict.',
      ],
    },
    {
      heading: '5. Acceptable use',
      body: [
        'Use the software lawfully. In particular, you agree not to use it to: gain unauthorised access to any system or account; circumvent access controls, licensing, or security measures; conduct denial-of-service or other disruptive attacks; scrape or access third-party services in breach of their terms or applicable law; engage in market manipulation, wash trading, spoofing, or any other conduct prohibited by the markets you touch; launder money or evade sanctions; or harm, defraud, or impersonate anyone.',
        'You are responsible for complying with the rules of every venue, exchange, protocol, launchpad, and data provider you interact with through the software, and for any licensing, reporting, and tax obligations that apply to you.',
      ],
    },
    {
      heading: '6. Third-party services',
      body: [
        `${PRODUCT_NAME} connects to services we do not own or control — RPC providers for Solana, Robinhood Chain and BNB Smart Chain, market-data APIs, launchpads, transaction relayers, a bridge aggregator, and, if you switch them on, chat platforms. Your use of those services is governed by their terms, not ours.`,
        'Bridging is different from everything else in this software and is off until you switch it on. When you move a chain’s coin to another chain, your funds leave your wallet into a third party’s bridge contracts and are delivered on the other chain by that third party (routed through LI.FI, li.quest). For the time in between, nobody you know holds them. The software checks what it can — the contract it pays, the amount, and where it can read it, the recipient — and it cannot check the rest; a transfer can arrive late, arrive as a different token, be refunded on the chain it left, or fail. We are not the bridge, we do not hold your funds at any point, and we cannot recover a transfer.',
        'Launching a token is your own act of issuance. A token you create with this software is created by you, on chain, under your key: it cannot be unmade, it is attributable to your wallet, and any fees it earns you and any obligations it creates are yours. The software builds the transaction you asked for and nothing else.',
        'We do not guarantee that any third-party service will be available, accurate, timely, or fit for any purpose. A third party can change, rate-limit, break, or withdraw its service at any time, and that may stop parts of the software working.',
        'Automated or high-frequency interaction with a third-party service may breach that service\'s rules and result in rate-limiting, blocking, or account termination by that provider. That risk is yours.',
      ],
    },
    {
      heading: '7. Intellectual property',
      body: [
        `The software, its name, its interface, and its documentation are owned by ${LEGAL_ENTITY} or its licensors, except for components under their own open-source licences.`,
        'Third-party names and marks that appear in the software are the property of their owners and are used only to describe compatibility. Their appearance does not imply any affiliation with, sponsorship by, or endorsement from those owners.',
      ],
    },
    {
      heading: '8. Disclaimer of warranties',
      emphasis: true,
      body: [
        `THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, ${LEGAL_ENTITY.toUpperCase()} DISCLAIMS ALL WARRANTIES INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ANY WARRANTY THAT THE SOFTWARE WILL BE UNINTERRUPTED, ERROR-FREE, ACCURATE, SECURE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.`,
        'NO ADVICE OR INFORMATION, WHETHER ORAL OR WRITTEN, OBTAINED FROM US OR THROUGH THE SOFTWARE, CREATES ANY WARRANTY NOT EXPRESSLY STATED HERE.',
      ],
    },
    {
      heading: '9. Limitation of liability',
      emphasis: true,
      body: [
        `TO THE FULLEST EXTENT PERMITTED BY LAW, ${LEGAL_ENTITY.toUpperCase()} WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, CRYPTOCURRENCY, TOKENS, OR GOODWILL, ARISING OUT OF OR RELATING TO THE SOFTWARE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY.`,
        `OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SOFTWARE IS LIMITED TO ${CAP.toUpperCase()}. THE SOFTWARE IS PROVIDED FREE OF CHARGE, AND THIS CAP REFLECTS THAT.`,
        'Nothing in these Terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for anything else that cannot lawfully be excluded or limited.',
      ],
    },
    {
      heading: '10. Indemnification',
      body: [
        `You agree to indemnify and hold harmless ${LEGAL_ENTITY} and its officers, employees, and agents from any claim, loss, liability, or expense (including reasonable legal fees) arising from your use of the software, your breach of these Terms, your violation of any law, or your violation of any third party's rights.`,
      ],
    },
    {
      heading: '11. Termination',
      body: [
        'You may stop using the software at any time by uninstalling it.',
        'This licence terminates automatically if you breach these Terms. Sections that by their nature should survive termination — disclaimers, liability limits, indemnity, and dispute resolution — survive it.',
      ],
    },
    {
      heading: '12. Copyright complaints',
      body: [
        `If you believe material we publish infringes your copyright, contact ${CONTACT_EMAIL} with: identification of the work, identification of the material and where it is, your contact details, a statement that you believe in good faith the use is not authorised, a statement under penalty of perjury that your notice is accurate and you are authorised to act, and your signature.`,
        'We do not host user-submitted content, so this concerns material we publish ourselves.',
      ],
    },
    {
      heading: '13. Dispute resolution, arbitration, and class-action waiver',
      emphasis: true,
      body: [
        'PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS, INCLUDING YOUR RIGHT TO GO TO COURT AND TO PARTICIPATE IN A CLASS ACTION.',
        `Except as stated below, any dispute arising out of or relating to the software or these Terms will be resolved by binding individual arbitration administered by ${ARBITRATION_FORUM} under ${ARBITRATION_RULES}. The seat of arbitration is ${VENUE}, and the arbitration may be conducted remotely. The AAA's rules govern how fees are allocated; where those rules place the cost of a consumer arbitration primarily on the business, we will bear it accordingly.`,
        'YOU AND WE EACH WAIVE THE RIGHT TO A JURY TRIAL AND THE RIGHT TO PARTICIPATE IN A CLASS, COLLECTIVE, OR REPRESENTATIVE ACTION. Claims may be brought only in an individual capacity.',
        'If the class-action waiver in this section is found unenforceable, that waiver alone is severed and the remainder of this arbitration agreement continues to apply. The rest of this section does not fall with it.',
        'Either party may bring an individual claim in small-claims court instead, if it qualifies. Either party may also seek injunctive relief in court to protect intellectual property rights.',
        'If you are a consumer resident in the European Union or the United Kingdom, nothing in this section deprives you of the protection of mandatory provisions of the law of your country of residence, including your right to bring proceedings in the courts of that country.',
      ],
    },
    {
      heading: '14. Governing law',
      body: [
        `These Terms are governed by the laws of ${GOVERNING_LAW}, without regard to its conflict-of-laws rules. Where arbitration does not apply, the courts of ${VENUE} have jurisdiction.`,
        'This choice of law does not override mandatory consumer protections available to you where you live. Consumers in the European Union and the United Kingdom in particular retain the rights their local law gives them, and may be able to bring proceedings locally regardless of this section.',
      ],
    },
    {
      heading: '15. Changes to these Terms',
      body: [
        'We may update these Terms. Material changes come with a new version number, and the software will ask you to review and accept the updated Terms before you continue using it.',
        'If you do not accept the updated Terms, stop using the software.',
      ],
    },
    {
      heading: '16. Contact',
      body: [`Questions about these Terms: ${CONTACT_EMAIL}.`],
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════
// 2. Privacy Policy
// ══════════════════════════════════════════════════════════════════════

export const PRIVACY_POLICY: LegalDocument = {
  id: 'privacy',
  title: 'Privacy Policy',
  subtitle: `Last updated ${TERMS_EFFECTIVE_DATE}`,
  sections: [
    {
      heading: '1. Controller',
      body: [
        `${LEGAL_ENTITY} is the data controller for the limited processing described here. Contact: ${CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: '2. The short version',
      body: [
        `${PRODUCT_NAME} runs on your computer. We operate no server for it, so there is nowhere for us to collect your data and no ${BRAND} account holding it. We do not receive your wallet keys, your trades, your settings, or your activity.`,
        'That is not the whole story, and the rest of this policy is the part that matters: the software talks directly from your machine to third-party services, and those services see your requests and your IP address. We do not control what they do with that.',
      ],
    },
    {
      heading: '3. What stays on your machine',
      body: [
        'All of the following is written to your own computer and never transmitted to us: your settings; your wallet keys; your watchlist; your orders and trade history; recorded market events, if you switch recording on; crash logs; and your record of accepting these documents.',
        'Wallet keys are encrypted at rest using your operating system\'s secure storage (DPAPI on Windows). If your OS cannot provide secure storage, the software refuses to store a key rather than storing it unprotected.',
        'You can delete all of it by uninstalling the software and removing its data folder.',
      ],
    },
    {
      heading: '4. What leaves your machine, and to whom',
      body: [
        'The software makes requests directly from your computer to third parties. Each of them can see your IP address, the timing of your requests, and what you asked for — which, for a market-data provider, reveals which tokens you are looking at.',
        'Blockchain access (Solana): api.mainnet-beta.solana.com, solana-rpc.publicnode.com, mainnet.helius-rpc.com and sender.helius-rpc.com (if you supply a Helius key), plus any additional RPC endpoints you configure yourself.',
        'Blockchain access (Robinhood Chain and BNB Smart Chain): rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com, rpc.ordofi.network, robinhood-mainnet.g.alchemy.com (only if you supply an Alchemy key), bsc-rpc.publicnode.com, bsc-dataseed.bnbchain.org, rpc-bnb.blockmachine.io, plus any RPC URL you configure yourself. No single public endpoint serves everything these chains need, so reads are split by what each one can answer: receipts, balances at a past block, event logs, simulation and broadcast may each go to a different one of these.',
        'Market data: api.dexscreener.com, api.geckoterminal.com, lite-api.jup.ag (or api.jup.ag if you supply a Jupiter key), public-api.birdeye.so, frontend-api-v3.pump.fun, swap-api.pump.fun, api.rugcheck.xyz.',
        'Trade execution: pumpportal.fun (transaction relayer), bundles.jito.wtf and mainnet.block-engine.jito.wtf (transaction submission lanes).',
        'Token images and metadata: ipfs.io and cloudflare-ipfs.com, and — because a token’s image is whatever URL its creator published — any public image host that URL points to.',
        'Bridging (the Bridge page, off by default): li.quest. Pricing a transfer necessarily sends the aggregator the amount and BOTH of your own wallet addresses — the one the money leaves and the one it arrives at — and following a transfer sends its transaction hash. For the minutes a transfer is in flight, your funds are held by the bridge’s own contracts, not by you and not by us; see the Terms.',
        'Launching a token (the Launch page, off by default): pump.fun receives the image you chose and the name, symbol, description and links you typed, and pins them publicly. Nothing else — no wallet address, no key — is sent with them.',
        'Update check: thirty seconds after every start, and every six hours after, the software fetches a small version file from krypt.cc to learn whether a newer build exists. That request carries no identifier and no data about you, but like any request it reveals your IP address to the host serving the file (our site is fronted by Cloudflare, which sees it too). Nothing is downloaded or installed automatically; the software only shows a notice.',
        'Discord Rich Presence, only if you switch it on: the Discord client on your own computer is told what the software is doing so it can show it on your profile. Nothing is sent to us.',
        'GIF search, only if you enable it and supply your own key: api.giphy.com or tenor.googleapis.com.',
        'Reward rates (the Rewards page): api.merkl.xyz. Listing the published reward campaigns on a chain sends no address. Asking what YOUR wallets are earning necessarily sends that wallet address to Merkl, so the software only does it when you ask it to, and says so where you ask.',
        'Chat notifications, only if you enable and pair them: api.telegram.org, discord.com.',
        'AI analysis, only if you enable it and supply your own key: api.openai.com or api.anthropic.com. When you run an analysis, the public on-chain facts about that one token (the same facts shown in the app — no wallet address, no key) are sent to whichever provider you chose, under that provider’s own terms and privacy policy. It is off by default and never runs on its own.',
        'Links you click deliberately may open your browser at solscan.io, robinhoodchain.blockscout.com, bscscan.com, dexscreener.com, x.com, dashboard.helius.dev, dashboard.alchemy.com, or our own site.',
        'Market data can be switched off entirely in Settings, which stops the market-data requests above. The blockchain and execution requests are what the software does; they cannot be switched off while you are using it to trade.',
      ],
    },
    {
      heading: '5. What we collect',
      body: [
        'Nothing about you. There is no telemetry, no analytics, no crash reporting to us, no advertising identifiers, and no tracking built into this software. The one automatic request the software makes to us is the update check described in section 4 — a fetch of a public version file that carries nothing about you.',
        'That claim is about us, and it has a limit worth stating in the same breath: the third-party services listed in section 4 still see your IP address and your requests when the software talks to them. "No telemetry" means we built no channel that reports you to us. It does not mean nothing about you leaves your computer.',
        `If you email us at ${CONTACT_EMAIL}, we hold that correspondence in order to answer you.`,
        'If you choose to send us a crash log, you are sending us a file you can read first. We do not collect them by ourselves.',
      ],
    },
    {
      heading: '6. Cookies',
      body: [
        'The application uses no cookies and no advertising or analytics trackers. It is not a website.',
      ],
    },
    {
      heading: '7. Legal basis (GDPR Article 6)',
      body: [
        'Where the GDPR applies, the limited processing we do rests on: legitimate interests (Article 6(1)(f)) for keeping a record that you accepted these terms, which we need in order to establish and defend legal claims; and contract or legitimate interests (Article 6(1)(b) and (f)) for answering correspondence you initiate.',
        'The processing done by the third-party services listed above is carried out by those services as their own controllers, under their own legal bases and policies.',
      ],
    },
    {
      heading: '8. Retention',
      body: [
        `Your acceptance record is kept on your machine for ${Math.round(ACCEPTANCE_RETENTION_DAYS / 365)} years, then deleted automatically by the software. This period matches the limitation period for contract claims.`,
        'Recorded market events, if you enable recording, are capped by a size limit you set and pruned oldest-first automatically. Recording is off by default.',
        'Crash logs are kept for 7 days and then deleted automatically.',
        'Every retention period above is enforced by code in the software, not by policy alone.',
        'Correspondence you send us is kept only as long as needed to deal with it.',
      ],
    },
    {
      heading: '9. Your rights',
      body: [
        'Because your data is on your own computer and we do not hold it, you already have complete access to it, can export it by copying the files, and can erase it by deleting them. No request to us is needed and none is possible.',
        'For the correspondence we do hold, and where the law gives you these rights, you may request access, correction, erasure, restriction, portability, or object to processing. Contact ' + CONTACT_EMAIL + '.',
        'You have the right to complain to your local data protection authority.',
      ],
    },
    {
      heading: '10. IP addresses',
      body: [
        'We keep no server for this software and no account for you, so there is no log of yours to keep. The one request the software makes to us — the update check — reaches our website, and a website’s host (ours is fronted by Cloudflare) sees the IP address of every request it serves; we do not read those logs to identify users. If we ever record an IP for evidential purposes, it will be stored only as a salted SHA-256 hash, never in raw form.',
        'The third-party services listed in section 4 do see your IP address. If that matters to you, a VPN and disabling market data are the controls available to you.',
      ],
    },
    {
      heading: '11. Children',
      body: [
        `The software is not for anyone under ${MINIMUM_AGE}. We do not knowingly collect anything from children.`,
      ],
    },
    {
      heading: '12. International transfers',
      body: [
        'We do not transfer your data internationally, because we do not receive it. Requests your software makes to third-party services may reach servers in other countries, including the United States, under those providers\' own arrangements.',
      ],
    },
    {
      heading: '13. Changes',
      body: [
        'We may update this policy. Material changes come with a new version number and the software will ask you to review it.',
      ],
    },
    {
      heading: '14. Contact',
      body: [`Privacy questions: ${CONTACT_EMAIL}.`],
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════
// 3. Software Terms — the download-time layer
// ══════════════════════════════════════════════════════════════════════

export const SOFTWARE_TERMS: LegalDocument = {
  id: 'software',
  title: 'Software Terms & Risk Disclosure',
  subtitle: `Downloadable software · trading tool · last updated ${TERMS_EFFECTIVE_DATE}`,
  sections: [
    {
      heading: '1. What this covers',
      body: [
        `These Software Terms apply to ${PRODUCT_NAME} as software you download, install, and run. They sit alongside the Terms of Service and add the terms that matter specifically for downloadable software and for a tool that trades.`,
        'You accepted these terms in the application before using it. If you do not accept them, uninstall the software.',
      ],
    },
    {
      heading: '2. As-is, no warranty',
      emphasis: true,
      body: [
        `THE SOFTWARE IS PROVIDED "AS IS", WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND. ${LEGAL_ENTITY.toUpperCase()} EXPRESSLY DISCLAIMS ALL WARRANTIES, EXPRESS, IMPLIED, OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AND ANY WARRANTY THAT THE SOFTWARE IS FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.`,
        'WE DO NOT WARRANT THAT THE SOFTWARE WILL RUN WITHOUT INTERRUPTION OR ERROR, THAT DEFECTS WILL BE CORRECTED, THAT IT WILL WORK WITH YOUR HARDWARE OR SOFTWARE, OR THAT ITS DATA IS ACCURATE OR CURRENT.',
      ],
    },
    {
      heading: '3. Assumption of risk and release',
      emphasis: true,
      body: [
        'YOU USE THIS SOFTWARE ENTIRELY AT YOUR OWN RISK, AND YOU KNOWINGLY ASSUME ALL RISKS ASSOCIATED WITH IT — INCLUDING TOTAL LOSS OF FUNDS.',
        `TO THE FULLEST EXTENT PERMITTED BY LAW, YOU RELEASE AND FOREVER DISCHARGE ${LEGAL_ENTITY.toUpperCase()} FROM ALL CLAIMS, DEMANDS, AND DAMAGES OF EVERY KIND ARISING FROM OR CONNECTED TO YOUR USE OF THE SOFTWARE, WHETHER KNOWN OR UNKNOWN.`,
        `OUR TOTAL LIABILITY IS CAPPED AT ${CAP.toUpperCase()}, AS STATED IN THE TERMS OF SERVICE.`,
      ],
    },
    {
      heading: '4. Not financial advice',
      emphasis: true,
      body: [
        'NOTHING IN THIS SOFTWARE IS FINANCIAL, INVESTMENT, TRADING, LEGAL, OR TAX ADVICE. NOTHING IT DISPLAYS IS A RECOMMENDATION TO BUY, SELL, OR HOLD ANYTHING.',
        'Scores, risk flags, signals, intel, rankings, and any other output are automated, heuristic, frequently wrong, and provided for information only. Treat them as one input to your own judgment, never as a verdict.',
      ],
    },
    {
      heading: '5. We are not a broker, adviser, or fiduciary',
      body: [
        `${LEGAL_ENTITY} is not a broker, dealer, exchange, custodian, commodity trading advisor, investment adviser, or fiduciary. We are not registered with the SEC, CFTC, FCA, or any other financial regulator, and no such registration is claimed.`,
        'Using this software creates no advisory, brokerage, agency, or fiduciary relationship between you and us. We never take custody of your funds, never hold your keys, and never execute anything on your behalf — the software runs on your computer and signs with your key under your control. (A bridge transfer, if you switch bridging on, is held in transit by the bridge’s own contracts — a third party, never us; see the Terms of Service.)',
      ],
    },
    {
      heading: '6. Risk of loss',
      emphasis: true,
      body: [
        'TRADING CRYPTOCURRENCY INVOLVES SUBSTANTIAL RISK, INCLUDING THE TOTAL AND PERMANENT LOSS OF EVERYTHING YOU PUT IN. MEMECOINS ARE AMONG THE MOST VOLATILE AND HIGHEST-RISK ASSETS IN EXISTENCE. MANY GO TO ZERO. MANY ARE OUTRIGHT FRAUDS.',
        'Automated and semi-automated systems can lose money faster than a human can react, through software bugs, network outages, stale or wrong data, latency, failed or partially filled transactions, misconfiguration, and simple mistakes in your own settings.',
        'Blockchain transactions are irreversible. A transaction sent in error, to the wrong token, at the wrong size, or with the wrong settings cannot be recalled by us or by anyone.',
        'Additional risks include, without limitation: rug pulls and exit scams; malicious or honeypot token contracts that prevent selling; front-running and sandwich attacks; liquidity disappearing; failed transactions that still cost fees; RPC and relayer outages; protocol changes that break the software mid-trade; and total loss of funds if your private key is exposed.',
        'Never trade with money you cannot afford to lose entirely.',
      ],
    },
    {
      heading: '7. No performance claims',
      body: [
        'We make no claim, promise, projection, or guarantee about profit, returns, win rate, or performance of any kind, and nobody is authorised to make one on our behalf.',
        'Any backtest, simulation, paper-trading result, or shadow-mode figure the software produces is hypothetical. It did not happen. Simulated results routinely fail to reflect real slippage, latency, fees, liquidity, and market impact, and are not indicative of future results. Past performance, real or simulated, indicates nothing about the future.',
      ],
    },
    {
      heading: '8. Fees',
      body: [
        `${BRAND} charges a platform fee on trades executed through the software. The current rate is shown in the application before you trade and in Settings. It is charged inside the same blockchain transaction as your trade wherever the venue allows it, so it is visible on-chain; on launchpad curves that cannot carry a fee it is a separate transfer sent immediately after the fill, and on four.meme sells the whole fee goes to the treasury with no referrer share.`,
        'This is separate from, and in addition to, fees charged by the launchpad, protocol, relayer, or network — none of which we receive. Network and priority fees are paid to validators.',
        'If you entered a referrer, a share of our fee is sent to that address in the same transaction. It comes out of our fee and does not increase what you pay.',
        'We may change the fee. Material changes come with a new version of these terms and you will be asked to accept them.',
      ],
    },
    {
      heading: '9. Your responsibility for your own system and funds',
      body: [
        'You are responsible for the security of your computer, your operating system account, your backups, and your private keys. Anyone with access to your machine and your OS account may be able to use the software.',
        'Back up your keys before you use the software. Take a system restore point before installing. We are not responsible for data loss, file corruption, system configuration changes, hardware problems, or any voided warranty arising from installing or running the software.',
        'The software stores keys encrypted with your operating system\'s secure storage. That protects the file at rest; it does not protect you from malware running as you, from someone with access to your unlocked machine, or from your own mistakes.',
      ],
    },
    {
      heading: '10. Verify before you run',
      body: [
        'You are encouraged to scan the installer with antivirus software, verify any published checksum, review the source where it is available, and run the software in an environment you are comfortable with before trusting it with funds.',
        'Only builds obtained from our official channels are ours. We are not responsible for copies obtained from mirrors, re-uploads, torrents, or third-party download sites, which may have been modified. If a build\'s checksum does not match one we published, do not run it.',
        'This software is not code-signed at present. Your operating system may warn you about an unrecognised publisher. We would rather tell you that than have you assume the warning is nothing.',
      ],
    },
    {
      heading: '11. Third-party terms and the risk of being blocked',
      body: [
        'The software interacts with third-party services that have their own rules. Automated, rapid, or high-volume use may breach those rules.',
        'Consequences can include rate-limiting, IP blocking, API key revocation, and termination of your account with that provider. Some venues prohibit automated access entirely. You are responsible for knowing the rules of every service you point this software at, and that risk is yours alone.',
      ],
    },
    {
      heading: '12. Prohibited uses',
      body: [
        'You must not use the software to: access any system or account without authorisation; circumvent digital rights management, licensing, or security controls; conduct denial-of-service or other disruptive attacks; scrape or access services in breach of law or contract; manipulate markets, including wash trading, spoofing, layering, or pump-and-dump schemes; defraud anyone; launder money or evade sanctions; or break any law that applies to you.',
      ],
    },
    {
      heading: '13. What we do not publish',
      body: [
        'We do not publish credential stealers, remote access trojans, spyware, keyloggers, ransomware, stressers or booters, or tools whose purpose is to circumvent anti-cheat or DRM systems.',
        `If you believe something we publish does any of this, tell us at ${CONTACT_EMAIL} and we will investigate.`,
      ],
    },
    {
      heading: '14. No support, no updates, no availability guarantee',
      body: [
        'The software is provided without any obligation of support, maintenance, bug fixes, updates, or continued availability. We may change it, break it, or stop publishing it at any time without notice.',
        'Third-party services the software depends on may change or disappear, and parts of the software may stop working as a result. We are not obliged to fix that.',
      ],
    },
    {
      heading: '15. Open-source components',
      body: [
        'The software includes third-party open-source components under their own licences, which govern those components and prevail over these terms for them.',
        `Where a component's licence requires it, the corresponding licence text is included with the software, and where a licence requires an offer of source code, that offer is available by writing to ${CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: '16. Trademarks',
      body: [
        'Solana, pump.fun, Raydium, Jito, Helius, Telegram, Discord, and all other third-party names and marks belong to their respective owners. They are used only to describe interoperability. No affiliation, sponsorship, partnership, or endorsement is implied or should be inferred.',
      ],
    },
    {
      heading: '17. Export controls and sanctions',
      body: [
        'You must comply with all applicable export control and sanctions laws. You confirm you are not located in, ordinarily resident in, or acting on behalf of anyone in a comprehensively sanctioned jurisdiction, and that you are not on any restricted-party list such as the US Treasury\'s SDN list.',
      ],
    },
    {
      heading: '18. Your legal and tax obligations',
      body: [
        'You are responsible for determining whether your use of the software is lawful where you live, for any licences or registrations you may need, and for reporting and paying any taxes arising from your trading. We do not provide tax reporting and any figures the software shows you are not tax records.',
      ],
    },
    {
      heading: '19. Consumer rights',
      emphasis: true,
      body: [
        'NOTHING IN THESE TERMS EXCLUDES OR LIMITS LIABILITY FOR DEATH OR PERSONAL INJURY CAUSED BY NEGLIGENCE, FOR FRAUD OR FRAUDULENT MISREPRESENTATION, OR FOR ANY OTHER LIABILITY THAT CANNOT LAWFULLY BE EXCLUDED OR LIMITED.',
        'If you are a consumer, your statutory rights are not affected by these terms. Some jurisdictions do not allow the exclusion of implied warranties or the limitation of incidental or consequential damages, so parts of the sections above may not apply to you.',
      ],
    },
    {
      heading: '20. Arbitration notice',
      emphasis: true,
      body: [
        `THE TERMS OF SERVICE REQUIRE BINDING INDIVIDUAL ARBITRATION BEFORE ${ARBITRATION_FORUM.toUpperCase()} AND WAIVE YOUR RIGHT TO A JURY TRIAL AND TO PARTICIPATE IN A CLASS ACTION. THAT SECTION IS INCORPORATED INTO THESE SOFTWARE TERMS AND APPLIES TO DISPUTES ABOUT THE SOFTWARE.`,
        'This notice is given separately here because you may have obtained the software without ever visiting our website, and we do not want the arbitration agreement to come as a surprise.',
      ],
    },
    {
      heading: '21. Reporting',
      body: [
        `Report suspected malware, security vulnerabilities, or intellectual property complaints to ${CONTACT_EMAIL}. For security issues, please give us a reasonable opportunity to fix the problem before disclosing it publicly.`,
      ],
    },
  ],
};

export const ALL_DOCUMENTS: LegalDocument[] = [TERMS_OF_SERVICE, PRIVACY_POLICY, SOFTWARE_TERMS];

export function documentById(id: LegalDocument['id']): LegalDocument | undefined {
  return ALL_DOCUMENTS.find((d) => d.id === id);
}

/** Full plain text of a document — what gets hashed into the acceptance record,
 *  so the record proves WHAT was accepted, not merely that something was. */
export function documentText(doc: LegalDocument): string {
  return [
    doc.title,
    doc.subtitle,
    ...doc.sections.flatMap((s) => [s.heading, ...s.body]),
  ].join('\n');
}

/**
 * The plain-language summary shown in the clickwrap modal.
 *
 * legalcheck.md: "Show a modal that summarises the key terms in plain language —
 * not just links. The summary is what makes it enforceable when the user says
 * 'I never read it.'" Each line names the thing a court expects to have been
 * flagged: risk of total loss, no advice, arbitration and class waiver, age,
 * as-is, and the fee.
 */
export interface SummaryPoint {
  /** Short label — the thing being agreed. */
  title: string;
  /** One sentence, plain language, no legalese. */
  detail: string;
  /** Points a court expects to see conspicuously flagged. */
  flagged?: boolean;
}

export const CLICKWRAP_SUMMARY: SummaryPoint[] = [
  {
    title: 'You can lose everything',
    detail:
      'Memecoin trading carries a substantial risk of total loss. Blockchain transactions cannot be reversed. Never trade money you cannot afford to lose.',
    flagged: true,
  },
  {
    title: 'This is not financial advice',
    detail:
      'Scores, signals and intel are automated, often wrong, and for information only. We are not a broker, adviser, or fiduciary, and we are not registered with any financial regulator.',
    flagged: true,
  },
  {
    title: 'Provided as-is, with no warranty',
    detail: `The software comes with no guarantees of any kind, and our total liability to you is capped at ${CAP}.`,
    flagged: true,
  },
  {
    title: 'Arbitration and class-action waiver',
    detail: `Disputes go to binding individual arbitration before ${ARBITRATION_FORUM}. You give up the right to a jury trial and to join a class action. EU and UK consumers keep their local rights.`,
    flagged: true,
  },
  {
    title: `You are ${MINIMUM_AGE} or older`,
    detail: 'This software moves real money, so it is not for minors.',
    flagged: true,
  },
  {
    title: 'Your keys and your machine are yours',
    detail:
      'Keys are encrypted by your operating system and never sent to us. We cannot recover them, reverse a trade, or help if your machine is compromised.',
  },
  {
    title: `${BRAND} takes a ${feePctLabel()} fee on each trade`,
    detail: `A ${feePctLabel()} platform fee is charged inside the same transaction as your trade — about half the going rate for a memecoin terminal. It is visible on-chain and shown in Settings. This is separate from what the launchpad and network charge.`,
    flagged: true,
  },
  {
    title: 'We collect nothing',
    detail:
      'There is no server, no account, and no telemetry. But the app talks directly to third-party data and blockchain providers, and they see your IP and your requests.',
  },
];
