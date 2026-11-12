# Optimiser les lectures réseau et les workflows

Plan préparé puis exécuté le 12 novembre 2026 pour `stake-dao/bounties-report`, sur `fix/ci-network-efficiency` depuis `origin/main` a9f07782. Les changements ne sont pas activés sur main. Voir le [journal d’exécution](EXECUTION.md) pour les preuves, décisions et dépendances de livraison.

## Résumé

1. Retirer l’indexeur Snapshot des claims Votium, sans retirer celui des forwarders.
2. Empêcher une collecte incomplète de publier un checkpoint et une vérification échouée de rendre la CI verte.
3. Diagnostiquer les erreurs explorer puis limiter le débit et borner les retries au même endroit pour tous les consommateurs.
4. Prouver la sûreté d’une réutilisation mémoire vlCVX avant de l’activer, sans partager les poids Curve/FXN.
5. Installer les dépendances une fois par job et supprimer les installations dynamiques de tsx dans les dix Makefiles.
6. Comparer les sorties et les appels sur des entrées identiques avant de mesurer le prochain run autorisé.

## Sources et état initial

- Run de référence : https://github.com/stake-dao/bounties-report/actions/runs/43221832855 ; 30 min 48 s, réussi. Claims : 15 min 36 s ; indexeur Snapshot : 14 min 03 s. BSC/Base : environ 13 min 35 s, 188 tranches vides. Les 162 erreurs explorer du run déclenchent 27 minutes de pauses fixes ; ces coûts se recouvrent et ne doivent pas être additionnés.
- Code étudié au HEAD local `574463d37ff590b8f9d9c44f898b466409b78032`. Main distant observé : `a9f0778229e230502f9c9fe9bd20bcd4c029a692`. Les helpers centraux sont identiques ; main contient notamment des protections CA, des versions Node/Python plus récentes et un chemin nodeenv versionné. Les préserver.
- Le checkout contient des modifications étrangères sur sdTokens, constants, types et leurs tests. Ne pas les copier, modifier, réinitialiser ou committer avec ces lots. Exécuter depuis un worktree propre basé sur le main distant alors courant, puis refaire les contrôles de dérive de chaque lot.
- Baseline exécutée sur le checkout local : `pnpm exec vitest run script/test/unit/onChainDelegation.test.ts script/test/unit/forwarderCache.test.ts script/test/unit/convexVotiumForwarderVp.test.ts script/test/unit/votemarketV2ClaimsGuard.test.ts` : 4 fichiers, 27 tests verts. Ce n’est ni une baseline de tout main ni une CI verte.
- Scripts disponibles : `pnpm test:unit`, `pnpm test:integration`, `pnpm test`. Pas de script lint/typecheck déclaré. `pnpm exec tsc --noEmit` n’est une barrière que si la baseline propre réussit et que tsc est disponible ; ne pas inventer de commande ni réparer les erreurs étrangères.

## Ordre et statut

| Lot | Résultat | Priorité | Effort | Risque | Dépendance | Statut |
| --- | --- | --- | --- | --- | --- | --- |
| [001](001-scope-workflows.md) | Workflows limités à leurs dépendances | P1 | S | Faible | Aucune | Implémenté, testé |
| [002](002-index-integrity.md) | Index incomplet ou vérification échouée = échec visible | P1 | M | Moyen | 001 pour livraison | Cache ici ; CLI/fraîcheur dans PR #251 |
| [003](003-explorer-policy.md) | Débit, diagnostic et retries communs | P1 | M | Moyen | 002 | Implémenté, testé ; cause historique NOTOK inconnue |
| [004](004-vlcvx-read-reuse.md) | Étude puis réutilisation vlCVX seulement si complétude prouvée | P2 | M | Moyen | 003 | DIFFÉRÉ après expérimentation |
| [005](005-dependency-setup.md) | Une installation reproductible par job | P2 | S–M | Faible | Aucune | Implémenté, testé |

S = quelques heures ; M = environ une journée, vérification comprise. Estimation totale : 3–5 jours, à ajuster après reproduction des NOTOK et analyse de la divergence sdCRV.

001 et 005 peuvent être préparés séparément, mais touchent tous deux `claims.yaml` : un seul propriétaire l’édite à la fois. 002 peut être étudié en parallèle de 005 ; conserver un seul auteur à la fois pour tout fichier partagé. Chaque lot d’implémentation tient dans une PR réversible ; 004 commence par une étude pouvant conclure au report. Préférer une exécution séquentielle ; la parallélisation n’est pas nécessaire à ce chantier.

## Barrières communes de livraison

- Lire entièrement le lot choisi ; comparer les extraits au code courant, y compris `git diff -- <périmètre>` pour les changements non committés. Les dépendances livrées constituent des différences attendues, pas une raison de reproduire l’ancien code.
- Écrire le test de régression avant la correction. Exécuter la baseline ciblée puis `pnpm test:unit` sur le worktree propre. Identifier séparément tout échec préexistant. Ne pas lancer une génération réelle pour vérifier une simple modification d’orchestration.
- Valider les workflows avec actionlint si installé ; sinon parser le YAML avec une bibliothèque déjà disponible. Le parseur YAML seul ne valide pas les expressions GitHub : le signaler. Ne pas ajouter une dépendance de production pour ces contrôles.
- Pour les lots 003/004, utiliser un rejeu déterministe des mêmes réponses réseau, horloge, blocs et fichiers dans deux worktrees jetables. Comparer les montants par adresse/token/chaîne, les ensembles de bénéficiaires et les racines Merkle lorsque produites. Exclure seulement les métadonnées non financières explicitement listées. Exiger une égalité exacte ; une différence inexpliquée bloque la livraison.
- Relever durée, nombre de requêtes, nombre/durée des retries et plages de blocs dans ce rejeu. Les mesures sur mocks prouvent la réduction des requêtes, pas la durée future de GitHub Actions. Ne promettre aucun objectif arbitraire « moins de cinq minutes ».
- Correction après relecture du main de départ : `recovery-regressions.yaml` exécute bien `pnpm test:unit --maxWorkers=2` sur pull_request, avec filtre incluant `script/test/unit/**`. Les deux nouveaux fichiers de tests déclencheront ce contrôle. Suivre le SHA exact après livraison ; ne pas confondre les tests locaux et cette CI. Toute fusion main, relance d’un workflow qui écrit/publie, modification de schedule de production ou opération Safe nécessite l’accord explicite de l’utilisateur.
- Rollback : revert du lot concerné, pas de réécriture de données historiques ni de roots. Si un index publié est suspect, bloquer sa consommation et préparer sa reconstruction séparément ; ne pas restaurer une copie plus ancienne en avançant son checkpoint.

## Choix retenus et exclusions

- Ethereum-only concerne Votium, pas tout le dépôt. sdCAKE reste sur BSC, Spectra sur Base, et Votemarket V2 découvre ses chaînes via ContractRegistry.
- Pas de nouveau sélecteur de chaînes sans consommateur identifié. Le retrait de l’étape Votium suffit au gain de 001 ; le défaut de l’indexeur global reste inchangé.
- Pas de cache disque vlCVX, de cache de poids, de nouvelle infrastructure, de changement des règles financières ou de changement de plateformes actives.
- Pas de parallélisation massive des appels explorer : cela peut aggraver la contention d’une clé partagée. Le limiteur d’un processus ne garantit pas le quota partagé entre plusieurs workflows.
- La cause des NOTOK reste à établir. Les logs actuels privilégient `message` sur `result` ; le lot 003 doit produire les éléments manquants avant de calibrer les délais.
- La divergence sdCRV vient d’une couverture GraphQL arrêtée avant les quatre événements ; diagnostic reproduit en lecture seule et détaillé dans le journal. Aucun délégateur ni seuil modifié. La protection CLI/fraîcheur est livrée séparément dans [PR #251](https://github.com/stake-dao/bounties-report/pull/251), non intégrée à cette branche.
- Revue indépendante du plan effectuée : suppression d’un sélecteur de chaînes sans appelant, correction de la barrière CI non disponible et report de tout cache incrémental dont la complétude explorer n’est pas prouvée. Un hash RPC stable ne garantit pas l’absence de logs temporairement manquants dans l’explorer.
- Pas d’optimisation de fetch-depth, de changement des versions runtime ni de refonte des Makefiles au-delà de l’installation nécessaire.

## Entretien du plan

Statuts : TODO, IN PROGRESS, DONE, BLOCKED avec motif, DIFFÉRÉ avec justification pour l’optimisation conditionnelle de 004. À chaque lot, enregistrer la PR, les commandes et leur résultat, le statut réel des contrôles disponibles sur le SHA exact et les chiffres avant/après dans sa section de clôture. Si un lot doit changer de périmètre, mettre à jour ses critères et cet index avant de poursuivre. Une donnée externe manquante bloque seulement le lot qui en dépend.
