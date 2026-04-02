# GlobalExam_Ta_Mere


## Ce que fait le script

- Se connecte a Brave deja ouvert via CDP si Brave est installe.
- Bascule sur Google Chrome de base si Brave n'est pas installe.
- Detecte la page d'exercice active.
- Tente d'ouvrir la transcription audio si elle est disponible.
- Recupere le contenu visible de la page, les documents, les onglets et les questions a choix multiple.
- Detecte les champs a trou et les remplis si le modele renvoie une reponse exploitable.
- Attend un temps cohérent avant de cliquer sur le bouton de progression.
- Tente de fermer les modales bloquantes avant de continuer.

## Pre-requis

- Node.js installé
- Un compte OpenRouter avec une cle API

## Installation

1. Installe les dependances:

```bash
npm install
```

2. Verifie que les dependances principales sont bien installees:

```bash
npm list --depth=0
```

## Configuration

Le script lit sa configuration dans le fichier `.env`.

Exemple:

```env
OPENAI_API_KEY=your_openrouter_api_key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=google/gemini-2.5-flash
MAX_TEMPS_EXO=30
```

### Variables utilisees

- `OPENAI_API_KEY`: la cle OpenRouter.
- `OPENAI_BASE_URL`: l'URL de l'API OpenRouter.
- `OPENAI_MODEL`: le modele a utiliser.
- `MAX_TEMPS_EXO`: borne superieure du delai aleatoire pour les exercices texte.
- `BRAVE_CDP_URL`: optionnel, URL CDP de Brave si tu n'utilises pas le port par defaut `http://127.0.0.1:9222`.

## Comment lancer le navigateur

Le script essaie d'abord Brave. Si Brave n'est pas installe, il ouvre Google Chrome de base.

### Cas 1: Brave est installe

Le script se connecte a Brave via le protocole CDP. Il faut donc lancer Brave avec le port de debug actif.

1. Ferme Brave completement.
2. Relance Brave avec:

```bash
open -a "Brave Browser" --args --remote-debugging-port=9222
```

3. Ouvre ensuite ton POC / ton exercice dans Brave.

### Cas 2: Brave n'est pas installe

Le script ouvre Google Chrome de base automatiquement. Tu n'as rien a faire de plus, mais Chrome doit etre installe sur la machine.

## Lancer le script

```bash
node agent.js
```

## Comment ca marche

### 1. Connexion au navigateur

Le script se connecte a la session Brave deja ouverte via `connectOverCDP`. Il recupere l'onglet qui contient `global-exam.com` ou cree un nouvel onglet si besoin.

### 2. Attente du chargement

Avant d'analyser une page, le script attend:

- le chargement du document,
- la stabilisation du DOM,
- la disparition des indicateurs de chargement visibles.

Cela evite de raisonner sur une page encore en transition.

### 3. Extraction du contenu

Le script recupere:

- le texte visible general,
- les blocs de transcription,
- les contenus dans les frames,
- les questions a choix multiple,
- les champs texte / textes a trou,
- les onglets ou documents a ouvrir,
- les zones scrollables a explorer.

### 4. Appel au modele

Le script envoie le contexte a OpenRouter. Le modele doit repondre dans un format structure:

- `RADIOS` pour les QCM,
- `BLANKS` pour les champs a completer.

### 5. Application de la reponse

Le script:

- coche les bonnes reponses radio,
- remplit les champs texte,
- ferme les modales bloquantes,
- attend un temps coherent selon le type d'exercice,
- clique ensuite sur le bouton de progression (`Passer`, `Valider`, etc.).

## OpenRouter: c'est quoi ?

OpenRouter est une couche d'acces a plusieurs modeles d'IA via une API compatible type OpenAI.

En pratique:

- tu utilises une seule cle API,
- tu peux changer de modele sans modifier le code,
- tu peux choisir un modele rapide ou plus fiable selon ton besoin.

Pour ce projet, l'URL utilisee est:

```text
https://openrouter.ai/api/v1
```

## Comment recuperer une cle API OpenRouter

1. Va sur le site OpenRouter.
2. Cree un compte ou connecte-toi.
3. Ouvre la page des API keys dans ton tableau de bord.
4. Cree une nouvelle cle.
5. Copie la cle et place-la dans `OPENAI_API_KEY` dans ton `.env`.

Important:

- ne commit jamais ton `.env` dans Git,
- ne partage pas ta cle API,
- si la cle a fuites, regenere-la immediatement.

## Choix du modele

Le script marche avec n'importe quel modele expose par OpenRouter qui supporte l'endpoint chat/completions.

Suggestions de compromis:

- rapide et correct: `google/gemini-2.5-flash`
- plus fiable mais un peu plus lent: `openai/gpt-4.1`
- tres bon en raisonnement: `anthropic/claude-3.7-sonnet`

## Recommandation de demarrage

Si tu veux un bon compromis vitesse / fiabilite:

```env
OPENAI_MODEL=google/gemini-2.5-flash
```

Si tu veux prioriser la qualite:

```env
OPENAI_MODEL=openai/gpt-4.1
```

## Debogage

### Le script ne se connecte pas a Brave

- Verifie que Brave a bien ete lance avec `--remote-debugging-port=9222`.
- Verifie que `BRAVE_CDP_URL` pointe vers le bon port.
- Verifie que Brave est bien ouvert avant de lancer `node agent.js`.
- Si Brave n'est pas installe, le script utilise Google Chrome de base.

### Le modele repond a cote

- Essaie un modele plus fiable dans `OPENAI_MODEL`.
- Verifie que la transcription audio ou le texte visible ont bien ete charges.
- Reduis ou augmente `MAX_TEMPS_EXO` selon ton besoin.

### La page change trop vite

- Le script attend deja un delai adapte aux audios.
- Pour les exercices texte, l'attente est aleatoire dans la borne definie par `MAX_TEMPS_EXO`.

## Structure du projet

```text
GlobalExam_Ta_Mere/
├── agent.js
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```
