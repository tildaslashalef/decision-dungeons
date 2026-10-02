// Hand-written text for the Inbox generator: mail in Spanish, German,
// French, and Portuguese, and the paragraphs long digests are made of.
// Slots in braces are filled by generate.ts: {me} {exec} {execFirst}
// {colleague} {colleagueName} {colleagueEmail} {vendor} {contact} {invoice} {amount} {count} {iban} {site}
// {fake} {lookalike} {vendorDomain} {freemail}.

import type { Route } from "./generate.ts";

export interface Template {
  from: string;
  subject: string;
  body: string;
  link?: string;
  linkText?: string;
  attachment?: string;
  /** Where genuine mail is filed; phishing is always report_phishing. */
  route: Route;
  why: string;
}

interface Language {
  phishing: Template[];
  genuine: Template[];
}

export const TRANSLATED: Record<string, Language> = {
  es: {
    phishing: [
      {
        from: "Microsoft 365 <seguridad@{fake}>",
        subject: "Su contraseña caduca hoy",
        body: "Hola {me}:\n\nLa contraseña de su cuenta corporativa caduca en las próximas 24 horas. Para conservar el acceso al correo y a los archivos compartidos, confirme su contraseña actual en el siguiente enlace.\n\nEquipo de cuentas de Microsoft",
        link: "https://{fake}/verificar",
        linkText: "https://{site}",
        route: "report_phishing",
        why: "dominio que imita a Microsoft; el texto del enlace no coincide con su destino",
      },
      {
        from: "{exec} <{execFirst}.direccion@{freemail}>",
        subject: "¿Estás disponible?",
        body: "{me}, estoy en una reunión con el consejo y no puedo hablar. Necesito que compres {count} tarjetas regalo de Amazon de 200 $ para unos clientes. Envíame fotos de los códigos en cuanto las tengas. Te lo reembolso esta semana. Por favor, que quede entre nosotros.\n\n{execFirst}",
        route: "report_phishing",
        why: "el director suplantado desde un correo gratuito pide tarjetas regalo en secreto",
      },
      {
        from: "{contact} <cobros@{lookalike}>",
        subject: "Cambio de datos bancarios — factura {invoice}",
        body: "Estimada {me}:\n\nLe informamos de que {vendor} ha cambiado de entidad bancaria. A partir de hoy, realice todos los pagos a la nueva cuenta:\n\nIBAN: {iban}\n\nLe rogamos que actualice los datos antes de abonar la factura {invoice} por {amount} y que nos confirme por este medio. No llame a la oficina; estamos en plena auditoría.\n\nUn saludo,\n{contact}",
        route: "report_phishing",
        why: "cambio de cuenta bancaria desde un dominio parecido al del proveedor",
      },
      {
        from: "Correos Express <avisos@{fake}>",
        subject: "Su paquete está retenido en aduanas",
        body: "No hemos podido entregar su envío porque hay una tasa de aduana pendiente de 1,99 €. Pague en 48 horas o el paquete será devuelto al remitente.",
        link: "https://{fake}/pago",
        linkText: "Pagar y programar la entrega",
        route: "report_phishing",
        why: "una pequeña tasa reclamada a través de un dominio ajeno a la empresa de envíos",
      },
    ],
    genuine: [
      {
        from: "{colleagueName} <{colleagueEmail}>",
        subject: "¿Puedes revisar la conciliación de agosto?",
        body: "Hola {me}:\n\n¿Podrías echar un vistazo a la conciliación de las tarjetas de combustible de agosto antes del jueves? Hay una diferencia de unos 300 € que no consigo localizar. El archivo está en la carpeta del cierre.\n\nGracias,\n{colleague}",
        link: "https://harborline.sharepoint.com/sites/finance/cierre",
        route: "reply",
        why: "un compañero de harborline.io pide una revisión; el enlace va a SharePoint de la empresa",
      },
      {
        from: "{vendor} <facturacion@{vendorDomain}>",
        subject: "Factura {invoice}",
        body: "Buenos días:\n\nAdjuntamos la factura {invoice} por los servicios de septiembre. Importe: {amount}. Vencimiento: 30 días. Los datos de pago no han cambiado.\n\nAtentamente,\n{vendor}",
        attachment: "{invoice}.pdf",
        route: "finance",
        why: "factura en PDF desde el dominio real del proveedor, sin cambios de pago",
      },
      {
        from: "Microsoft <account-security-noreply@accountprotection.microsoft.com>",
        subject: "Nuevo inicio de sesión en su cuenta",
        body: "Hemos detectado un nuevo inicio de sesión en su cuenta desde Chrome en macOS (Madrid, España). Si fue usted, no tiene que hacer nada. Si no, revise la actividad reciente en account.microsoft.com. Nunca le pediremos su contraseña por correo.",
        link: "https://account.microsoft.com/security",
        route: "read_later",
        why: "remitente y sitio reales de Microsoft, no pide credenciales",
      },
      {
        from: "Recursos Humanos <personas@harborline.io>",
        subject: "Recordatorio: horario de verano",
        body: "Hola a todos:\n\nOs recordamos que el horario de verano termina el viernes. A partir del lunes volvemos a la jornada habitual. No hace falta hacer nada.\n\nUn saludo,\nPersonas",
        route: "read_later",
        why: "aviso interno de harborline.io que no pide nada",
      },
    ],
  },
  de: {
    phishing: [
      {
        from: "Microsoft 365 <sicherheit@{fake}>",
        subject: "Ihr Postfach wird heute gesperrt",
        body: "Hallo {me},\n\nwir konnten Ihr Konto nach dem letzten Sicherheitsupdate nicht verifizieren. Bestätigen Sie Ihre Anmeldedaten innerhalb von 24 Stunden, sonst wird Ihr Postfach gesperrt und eingehende E-Mails werden abgewiesen.\n\nIhr Microsoft-Kontoteam",
        link: "https://{fake}/anmelden",
        linkText: "https://{site}",
        route: "report_phishing",
        why: "Domain, die Microsoft imitiert; Linktext und Ziel stimmen nicht überein",
      },
      {
        from: "{exec} <{execFirst}.vorstand@{freemail}>",
        subject: "Kurze Bitte – vertraulich",
        body: "{me}, ich sitze den ganzen Tag in Vorstandssitzungen. Bitte kaufe {count} Apple-Geschenkkarten zu je 250 € für Kunden und schicke mir Fotos der Codes. Du bekommst das Geld diese Woche zurück. Bitte behalte das vorerst für dich.\n\n{execFirst}",
        route: "report_phishing",
        why: "der Geschäftsführer wird von einer Freemail-Adresse imitiert und verlangt Gutscheincodes",
      },
      {
        from: "{contact} <buchhaltung@{lookalike}>",
        subject: "Neue Bankverbindung – Rechnung {invoice}",
        body: "Sehr geehrte Frau Lindqvist,\n\naufgrund eines Bankwechsels bitten wir Sie, alle künftigen Zahlungen an {vendor} auf folgendes Konto zu überweisen:\n\nIBAN: {iban}\n\nBitte aktualisieren Sie die Daten vor der Zahlung der Rechnung {invoice} über {amount} und bestätigen Sie kurz per Antwort.\n\nMit freundlichen Grüßen\n{contact}",
        route: "report_phishing",
        why: "Änderung der Bankverbindung von einer Domain, die der des Lieferanten nur ähnelt",
      },
      {
        from: "DHL Paket <service@{fake}>",
        subject: "Zustellung fehlgeschlagen – Zollgebühr offen",
        body: "Ihre Sendung konnte nicht zugestellt werden, da eine Zollgebühr von 2,49 € aussteht. Bitte zahlen Sie innerhalb von 48 Stunden, sonst geht das Paket an den Absender zurück.",
        link: "https://{fake}/zahlen",
        linkText: "Jetzt bezahlen",
        route: "report_phishing",
        why: "kleine Gebühr über eine Domain, die nicht zu DHL gehört",
      },
    ],
    genuine: [
      {
        from: "{colleagueName} <{colleagueEmail}>",
        subject: "Budgetrunde am Montag",
        body: "Hallo {me},\n\nkönntest du für Montag zehn Minuten zur Abstimmung der Tankkarten einplanen? Gib mir bis morgen Bescheid, dann verschicke ich die Agenda.\n\nDanke!\n{colleague}",
        link: "https://docs.google.com/document/d/budgetrunde",
        route: "reply",
        why: "Kollege von harborline.io bittet um eine Rückmeldung",
      },
      {
        from: "{vendor} <rechnung@{vendorDomain}>",
        subject: "Rechnung {invoice}",
        body: "Guten Tag,\n\nanbei erhalten Sie die Rechnung {invoice} über {amount} für September. Zahlungsziel: 30 Tage. Unsere Bankverbindung bleibt unverändert.\n\nMit freundlichen Grüßen\n{vendor}",
        attachment: "{invoice}.pdf",
        route: "finance",
        why: "Rechnung als PDF von der echten Domain des Lieferanten, keine neue Bankverbindung",
      },
      {
        from: "Dropbox <no-reply@dropbox.com>",
        subject: "Neue Anmeldung bei Dropbox",
        body: "Es gab eine neue Anmeldung bei Ihrem Dropbox-Konto über Safari auf dem iPhone (Hamburg, Deutschland). Wenn Sie das waren, müssen Sie nichts tun. Andernfalls prüfen Sie Ihre Sicherheitseinstellungen auf dropbox.com.",
        link: "https://www.dropbox.com/account/security",
        route: "read_later",
        why: "echter Absender und echte Website von Dropbox, keine Aufforderung zur Passworteingabe",
      },
      {
        from: "FreightWaves <newsletter@freightwaves.com>",
        subject: "Die Woche in der Frachtfinanzierung",
        body: "Hallo {me},\n\ndiese Woche: Spotraten im Herbst, ein Kundenbeispiel eines mittelgroßen 3PL und eine Checkliste für den Jahresabschluss.\n\nSie erhalten diesen Newsletter, weil Sie ihn abonniert haben. Abmelden jederzeit möglich.",
        link: "https://freightwaves.com/unsubscribe",
        route: "promotions",
        why: "abonnierter Newsletter von der echten Domain",
      },
    ],
  },
  fr: {
    phishing: [
      {
        from: "Microsoft 365 <securite@{fake}>",
        subject: "Votre mot de passe expire aujourd'hui",
        body: "Bonjour {me},\n\nLe mot de passe de votre compte professionnel expire dans 24 heures. Pour conserver l'accès à votre messagerie, confirmez votre mot de passe actuel via le lien ci-dessous.\n\nL'équipe des comptes Microsoft",
        link: "https://{fake}/confirmer",
        linkText: "https://{site}",
        route: "report_phishing",
        why: "domaine qui imite Microsoft ; le texte du lien ne correspond pas à sa cible",
      },
      {
        from: "{exec} <{execFirst}.direction@{freemail}>",
        subject: "Demande urgente et confidentielle",
        body: "{me}, je suis en conseil d'administration toute la journée. J'ai besoin que tu achètes {count} cartes cadeaux de 200 € pour des clients et que tu m'envoies les codes en photo. Je te rembourse cette semaine. Merci de rester discrète.\n\n{execFirst}",
        route: "report_phishing",
        why: "le PDG usurpé depuis une messagerie gratuite réclame des codes de cartes cadeaux",
      },
      {
        from: "{contact} <comptabilite@{lookalike}>",
        subject: "Nouvelles coordonnées bancaires – facture {invoice}",
        body: "Madame,\n\nSuite à un changement de banque, merci d'effectuer désormais tous vos règlements à {vendor} sur le compte suivant :\n\nIBAN : {iban}\n\nMerci de mettre à jour vos données avant le règlement de la facture {invoice} d'un montant de {amount}, et de nous le confirmer en réponse à ce message.\n\nCordialement,\n{contact}",
        route: "report_phishing",
        why: "changement de RIB depuis un domaine qui ressemble à celui du fournisseur",
      },
      {
        from: "Colissimo <info@{fake}>",
        subject: "Votre colis est en attente",
        body: "Votre colis n'a pas pu être livré : des frais de douane de 1,99 € restent à régler. Payez sous 48 heures, faute de quoi il sera renvoyé à l'expéditeur.",
        link: "https://{fake}/paiement",
        linkText: "Régler les frais",
        route: "report_phishing",
        why: "petits frais réclamés via un domaine étranger au transporteur",
      },
    ],
    genuine: [
      {
        from: "{colleagueName} <{colleagueEmail}>",
        subject: "Relecture des provisions du T3",
        body: "Bonjour {me},\n\nPeux-tu relire les provisions de fret du troisième trimestre avant jeudi ? Le classeur est dans le dossier de clôture.\n\nMerci,\n{colleague}",
        link: "https://harborline.sharepoint.com/sites/finance/cloture",
        route: "reply",
        why: "un collègue de harborline.io demande une relecture",
      },
      {
        from: "{vendor} <facturation@{vendorDomain}>",
        subject: "Facture {invoice}",
        body: "Bonjour,\n\nVeuillez trouver ci-joint la facture {invoice} d'un montant de {amount}, payable à 30 jours. Nos coordonnées bancaires sont inchangées.\n\nCordialement,\n{vendor}",
        attachment: "{invoice}.pdf",
        route: "finance",
        why: "facture PDF depuis le vrai domaine du fournisseur, coordonnées inchangées",
      },
      {
        from: "Microsoft <account-security-noreply@accountprotection.microsoft.com>",
        subject: "Nouvelle connexion à votre compte",
        body: "Nous avons détecté une nouvelle connexion à votre compte depuis Edge sous Windows (Lyon, France). Si c'était vous, il n'y a rien à faire. Sinon, consultez l'activité récente sur account.microsoft.com. Nous ne vous demanderons jamais votre mot de passe par e-mail.",
        link: "https://account.microsoft.com/security",
        route: "read_later",
        why: "expéditeur et site réels de Microsoft, aucune demande d'identifiants",
      },
      {
        from: "Ressources humaines <rh@harborline.io>",
        subject: "Rappel : fermeture des inscriptions vendredi",
        body: "Bonjour,\n\nLes inscriptions aux avantages 2027 ferment vendredi. Sans changement de votre part, vos choix actuels sont reconduits.\n\nL'équipe RH",
        route: "read_later",
        why: "annonce interne de harborline.io qui ne demande rien",
      },
    ],
  },
  pt: {
    phishing: [
      {
        from: "Microsoft 365 <seguranca@{fake}>",
        subject: "A sua palavra-passe expira hoje",
        body: "Olá {me},\n\nA palavra-passe da sua conta empresarial expira nas próximas 24 horas. Para manter o acesso ao e-mail e aos ficheiros partilhados, confirme a sua palavra-passe atual no link abaixo.\n\nEquipa de contas Microsoft",
        link: "https://{fake}/confirmar",
        linkText: "https://{site}",
        route: "report_phishing",
        why: "domínio que imita a Microsoft; o texto do link não corresponde ao destino",
      },
      {
        from: "{exec} <{execFirst}.diretoria@{freemail}>",
        subject: "Preciso de um favor",
        body: "{me}, estou em reunião com o conselho o dia todo. Preciso que compre {count} cartões-presente de 200 € para clientes e me envie fotos dos códigos. Reembolso esta semana. Por favor, mantenha isto entre nós.\n\n{execFirst}",
        route: "report_phishing",
        why: "o CEO falsificado num e-mail gratuito pede códigos de cartões-presente em segredo",
      },
      {
        from: "{contact} <financeiro@{lookalike}>",
        subject: "Alteração de dados bancários — fatura {invoice}",
        body: "Cara {me},\n\nInformamos que a {vendor} mudou de banco. A partir de hoje, todos os pagamentos devem ser feitos para a nova conta:\n\nIBAN: {iban}\n\nAtualize os dados antes de pagar a fatura {invoice} de {amount} e confirme por resposta a este e-mail.\n\nCumprimentos,\n{contact}",
        route: "report_phishing",
        why: "alteração de conta bancária vinda de um domínio parecido com o do fornecedor",
      },
      {
        from: "CTT Expresso <avisos@{fake}>",
        subject: "Encomenda retida: taxa alfandegária pendente",
        body: "Não foi possível entregar a sua encomenda porque existe uma taxa alfandegária de 1,99 € por pagar. Pague em 48 horas ou a encomenda será devolvida ao remetente.",
        link: "https://{fake}/pagar",
        linkText: "Pagar e agendar entrega",
        route: "report_phishing",
        why: "pequena taxa cobrada através de um domínio alheio à transportadora",
      },
    ],
    genuine: [
      {
        from: "{colleagueName} <{colleagueEmail}>",
        subject: "Podes rever a reconciliação de agosto?",
        body: "Olá {me},\n\nConsegues rever a reconciliação dos cartões de combustível de agosto antes de quinta? Há uma diferença de cerca de 300 € que não encontro. O ficheiro está na pasta do fecho.\n\nObrigado,\n{colleague}",
        link: "https://harborline.sharepoint.com/sites/finance/fecho",
        route: "reply",
        why: "um colega de harborline.io pede uma revisão",
      },
      {
        from: "{vendor} <faturacao@{vendorDomain}>",
        subject: "Fatura {invoice}",
        body: "Bom dia,\n\nEnviamos em anexo a fatura {invoice} no valor de {amount}, com vencimento a 30 dias. Os dados de pagamento mantêm-se.\n\nCumprimentos,\n{vendor}",
        attachment: "{invoice}.pdf",
        route: "finance",
        why: "fatura em PDF do domínio real do fornecedor, sem alteração de pagamento",
      },
      {
        from: "Dropbox <no-reply@dropbox.com>",
        subject: "Novo início de sessão no Dropbox",
        body: "Houve um novo início de sessão na sua conta Dropbox a partir do Safari no iPhone (Lisboa, Portugal). Se foi você, não precisa de fazer nada. Caso contrário, reveja a segurança da conta em dropbox.com.",
        link: "https://www.dropbox.com/account/security",
        route: "read_later",
        why: "remetente e site reais do Dropbox, sem pedido de palavra-passe",
      },
      {
        from: "Gusto <news@gusto.com>",
        subject: "Novidades de conformidade salarial para o 4.º trimestre",
        body: "Olá {me},\n\nEsta semana: o que muda na conformidade salarial no fim do ano e uma lista de verificação para o fecho anual.\n\nRecebe esta newsletter porque se subscreveu. Pode cancelar a qualquer momento.",
        link: "https://gusto.com/unsubscribe",
        route: "promotions",
        why: "newsletter subscrita, do domínio real",
      },
    ],
  },
};

/** Plausible paragraphs for long digests: freight finance news and notes. */
export const LONG_PARAGRAPHS = [
  "Spot rates on the West Coast lanes softened again in September, down roughly four percent month over month, while contract rates held. Several carriers told us they expect the gap to narrow once peak season volume arrives in late October, so it may be worth revisiting any lanes still priced off the spot index.",
  "Diesel averaged $3.91 a gallon for the month. Our fuel card program covered 212 trucks, and the reconciliation found three duplicate transactions at a single station in Fresno, all refunded within a week. If you manage a fleet budget, the new monthly fuel report is in the shared drive.",
  "The audit team finished fieldwork for the half-year review. The main finding was timing: about a dozen freight invoices were booked a month late because they arrived after close. Procurement is piloting a change that asks carriers to submit invoices through the vendor portal within five business days of delivery.",
  "Customs brokerage fees rose modestly after the new filing requirements took effect. Bluewater absorbed most of the increase this quarter, but we should expect it to show up in next year's rate card. Anyone negotiating cross-border contracts should build in a small buffer.",
  "Warehouse utilization at the Tacoma site reached 91 percent, the highest since we opened it. Cascade has offered overflow space at the Kent facility on a month-to-month basis. Operations is comparing that against renegotiating the minimum-volume clause in the main contract.",
  "A reminder on expense policy: meals with carrier partners are reimbursable up to the posted limit, but alcohol must be itemized separately. Receipts photographed with the mobile app are accepted; you no longer need to mail originals to the finance office.",
  "The treasury team moved the operating account sweep from weekly to daily. Nothing changes for vendors or for anyone submitting payment requests, but cash positions in the morning report will now reflect the prior day's balances rather than the prior Friday's.",
  "Customer collections improved: days sales outstanding fell from 47 to 41 over the quarter. Most of the gain came from three large accounts moving to automatic payments. Customer success will share the playbook they used at next month's all-hands.",
  "On the systems side, the NetSuite upgrade is scheduled for the second weekend of November. Saved searches and custom reports should carry over, but please test anything you depend on in the sandbox before then and send issues to the finance systems channel.",
  "We welcomed two new carriers to the regional network this month, both specializing in temperature-controlled loads for food and pharmacy customers. Their onboarding paperwork, insurance certificates, and banking letters were verified through the usual call-back process.",
  "Industry conferences are filling up for the spring. If you plan to attend the freight finance summit in Chicago, submit the travel request by the end of the month so we can book the group rate. Speakers from our team will be announced in a later issue.",
  "Interest in electric yard tractors keeps growing. A pilot at the Tacoma yard cut fuel and maintenance costs for those units by about a third, though charging infrastructure added upfront spend. The business case will go to the capital committee in December.",
  "Last, thank you to everyone who joined the volunteer day at the food bank. Forty-two people from across the company packed just over nine thousand meals, and the photos are posted on the intranet.",
];
