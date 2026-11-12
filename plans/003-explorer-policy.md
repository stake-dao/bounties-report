# Lot 003 — Centraliser le débit et les retries explorer

Priorité P1 ; effort M ; risque moyen ; dépend de 002. Préparé le 12 novembre 2026 au commit local `574463d37ff590b8f9d9c44f898b466409b78032`, helper identique au main observé `a9f0778229e230502f9c9fe9bd20bcd4c029a692`.

## But et état actuel

Le run https://github.com/stake-dao/bounties-report/actions/runs/43221832855 contient 162 réponses explorer `NOTOK`, dont 84 dans les claims Ethereum. Chacune entraîne 10 secondes de pause. Le détail `result` est masqué par `message`. Le débit excessif est une hypothèse à vérifier, pas un diagnostic acquis.

```ts
// script/utils/explorerUtils.ts
const rateLimiter = new RateLimiter(5);
  private async makeRequest(url: string, retries = 5, delayMs = 10000) {
        const timeoutId = setTimeout(() => controller.abort(), 900000);
// ...
        lastError = String(data.message || data.result || "Unknown error");
```

Le limiteur borne la concurrence, pas les départs par seconde. Les collecteurs `cacheUtils.ts` et `forwarderCacheUtils.ts` ajoutent jusqu’à trois tentatives autour des cinq du helper. Les consommateurs incluent claims V1/V2/Votium, reports, Spectra, APR, résolutions de blocs et collecte on-chain vlCVX ; conserver leurs signatures publiques et la forme `{ result: ... }`.

## Périmètre et dérive

`script/utils/explorerUtils.ts`, `script/utils/cacheUtils.ts`, `script/utils/forwarderCacheUtils.ts`, nouveau `script/test/unit/explorerUtils.test.ts`, tests d’intégrité des collecteurs concernés. Documentation succincte dans `script/utils/README.md` si nécessaire. Aucun changement de chaîne, adresse, clé, service RPC, calcul de montants ou stratégie d’attribution.

Contrôle : `git diff --stat 574463d37ff590b8f9d9c44f898b466409b78032..HEAD -- script/utils/explorerUtils.ts script/utils/cacheUtils.ts script/utils/forwarderCacheUtils.ts` et diff non committé. Les changements de 002 sont attendus. Lire intégralement ces trois fichiers avant édition.

## Exécution et contrôles

1. Reproduire une réponse NOTOK avec `fetch` remplacé dans Vitest ; exposer `message` et un détail `result` borné et nettoyé, le chainId, l’action et la tentative. Ne jamais journaliser URL complète, clé API ou erreur brute contenant la requête. Ajouter une sonde en lecture seule sur une requête de logs équivalente si les accès sont disponibles ; aucune écriture ni workflow réel. Si les détails historiques ne sont pas récupérables, conserver cette incertitude et tester explicitement les familles d’erreurs sans présenter une hypothèse comme confirmée.
2. Définir les résultats permis : succès validé ; absence de logs documentée = tableau vide ; HTTP 429/5xx, timeout et rate limit API identifié = retry borné ; clé invalide, chaîne non supportée et erreur de paramètres = échec immédiat. Une réponse NOTOK inconnue reste une erreur, jamais un résultat vide. Ne pas appliquer la règle « no records » à une résolution de bloc pour en faire un succès numérique.
3. Mettre les départs de requêtes sous un limiteur partagé au niveau du module, y compris entre instances créées par la factory. Point de départ conservateur : un départ toutes les 500 ms, sans burst, avec concurrence bornée. Ajuster ce chiffre uniquement à partir du quota API documenté et des mesures ; ce n’est pas le quota utilisateur AI. Respecter un Retry-After valide, avec une borne globale de temps ; sinon backoff borné. Le mécanisme est local au processus : il ne coordonne pas les jobs utilisant la même clé.
4. Remplacer le timeout de 15 minutes par un timeout de tentative borné, proposé à 30 secondes, et un budget total proposé à 120 secondes, attente de queue comprise. Le timer est toujours nettoyé en finally et le budget couvre aussi la lecture JSON. Au plus quatre tentatives réseau ; une attente Retry-After au-delà du budget conduit à un échec explicite. Une requête sortie de sa queue après expiration ne doit pas partir. Justifier toute autre valeur avec une mesure.
5. Retirer les boucles de retry réseau redondantes de `fetchLogs` dans les deux collecteurs ; les échecs terminaux remontent. Garder les validations de données et les checkpoints protégés par 002. Ne pas changer les chunks, topics, ordre de concaténation ni pagination dans ce lot. Une éventuelle troncature constatée doit faire l’objet d’un test et d’un ajustement de plan, pas d’un résultat partiel accepté.

## Tests et barrières

Utiliser fake timers et mock de fetch via les méthodes publiques de la factory. Tester résultats exacts, non seulement absence d’exception : succès, absence valide, 429 puis succès, NOTOK rate-limit puis succès, erreur permanente en un essai, réponse mal formée, timeout pendant fetch et pendant body, budget épuisé dans la queue, Retry-After excessif, clé factice absente de toutes les sorties. Deux instances simultanées doivent respecter le débit global ; le nombre de requêtes est ici un contrat de performance à vérifier.

`pnpm exec vitest run script/test/unit/explorerUtils.test.ts script/test/unit/delegatorCacheIntegrity.test.ts script/test/unit/forwarderCache.test.ts script/test/unit/votemarketV2ClaimsGuard.test.ts script/test/unit/onChainDelegation.test.ts` puis `pnpm test:unit` : tous les tests concernés passent. Vérifier qu’une erreur terminale ne provoque pas quatre tentatives multipliées par trois couches.

Rejouer les mêmes réponses réussies dans les versions avant/après pour les méthodes logs simples, multi-adresses, topics seuls et résolution de bloc. Résultats identiques ; retries réduits uniquement sur erreurs classifiées. Le rejeu financier déterministe décrit dans `plans/README.md` doit conserver montants, bénéficiaires et racines. Aucune génération envoyant Telegram, pin IPFS ou commit ne doit tourner hors sandbox.

## Critères, arrêt et retour arrière

- [ ] Diagnostic exploitable sans secret ; cause des NOTOK confirmée ou explicitement inconnue.
- [ ] Limitation partagée entre instances, budget global et annulation vérifiés avec fake timers.
- [ ] Une erreur n’est jamais transformée en absence de logs ; les deux collecteurs ne multiplient plus les retries.
- [ ] Rejeux des méthodes publiques et financiers inchangés, hors erreurs désormais correctement remontées.

Arrêter si une API utilise des statuts incompatibles avec cette classification, si les données dépassent la taille de page de l’explorer ou si le budget proposé coupe des requêtes saines observées. Établir le cas réel et réviser le plan avant de changer de fournisseur ou d’augmenter les limites. Revert du code seulement ; ne pas restaurer les échecs silencieux de 002.

## Clôture à remplir

Implémenté : départ toutes les 500 ms, maximum cinq requêtes simultanées par processus, quatre essais maximum, tentative de 30 s et budget de 120 s incluant queue/JSON. HTTP 429/5xx, erreur réseau et rate limit API identifiée réessayés ; erreurs permanentes/inconnues/réponses mal formées échouent immédiatement. Retry-After respecté dans le budget. Diagnostic borné et clé masquée ; timers nettoyés. Les deux collecteurs n’ajoutent plus de retries réseau.

Quinze régressions explorer et sept d’intégrité passent, dont le libellé transitoire documenté « Unexpected err, timeout occurred or server too busy. Please try again later » ajouté après revue. Rejeu avant/après de l’énumération jusqu’à la répartition et au Merkle : mêmes bénéficiaires, 667/333 wei, même racine ; aucune donnée publiée écrite. Sonde Ethereum en lecture seule, registre Snapshot blocs 26390000–26390100 : zéro log valide en 487 ms. Cette sonde ne reproduit pas les NOTOK historiques : leur cause reste inconnue. Les limites sont conservatrices, pas une calibration démontrée du quota partagé entre jobs. Voir [le journal](EXECUTION.md).
