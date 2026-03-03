// Musical JARVIB - Teams SDK v2 entry point
import { App } from '@microsoft/teams.apps';
import { DevtoolsPlugin } from '@microsoft/teams.dev';
import { ChatPrompt, Message } from '@microsoft/teams.ai';
import { OpenAIChatModel } from '@microsoft/teams.openai';
import { MessageActivity } from '@microsoft/teams.api';
import { AdaptiveCard, TextBlock, Image as CardImage } from '@microsoft/teams.cards';

import socketapp from './app/socketapp';
import * as responses from './responses';

import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { createSseStream } from "@azure/core-sse"; 

// #region Interfaces
interface fullListItem {
  name: string;
  imageUrl: string;
  modelUrl: string;
}

interface ConversationState {
  greeted: boolean;
  fullList: fullListItem[];
  list: string[];
  lastModelLoaded: string;
  fullCode: string;
}

interface Item {
  name: string;
  imageUrl: string;
}
// #endregion

// #region State Management
// In-memory stores keyed by conversation ID
const conversationStates = new Map<string, ConversationState>();
const conversationMessages = new Map<string, Message[]>();

function getOrCreateState(conversationId: string): ConversationState {
  let state = conversationStates.get(conversationId);
  if (!state) {
    state = {
      greeted: false,
      fullList: [],
      list: [],
      lastModelLoaded: "",
      fullCode: "",
    };
    conversationStates.set(conversationId, state);
  }
  return state;
}

function getOrCreateMessages(conversationId: string): Message[] {
  let messages = conversationMessages.get(conversationId);
  if (!messages) {
    messages = [];
    conversationMessages.set(conversationId, messages);
  }
  return messages;
}
// #endregion

// #region Azure OpenAI direct client (for socket streaming)
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
const finalModelName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "gpt-4o";
const azureOpenAIClient = ModelClient(
  endpoint + "/openai/deployments/" + finalModelName,
  new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY || "")
);
// #endregion

// #region Build dynamic instructions for the ChatPrompt
function buildInstructions(state: ConversationState): string {
  return `Pretend you're an expert in Babylon.js, the JavaScript WebGL 3D engine. 

rules:
- assume there is already an existing Babylon.js scene and engine so you don't have to create them 
- just generate the code to add into an existing program.
- use the scene and engine objects directly.
- pay attention when trying to access previously created Meshes by getting access to them via their name rather than assuming the associated variable is already created
- when writing a new code, consider all the previous one you've generated to be sure the new code will be consistent with the previous one.
- remember about the already created meshes, animations or any other specific ressources before trying to create them or reuse them.
- if you receive a music note or asked to play a note, execute the transformMusicNote function

Here is the current list of available models to load:
${JSON.stringify(state.list)}

Current mesh model name loaded:
${state.lastModelLoaded || "none"}

Code executed so far:
${state.fullCode || "none"}`;
}
// #endregion

// #region Create the Teams SDK App
// DEBUG: Check if env vars are properly set
console.log('DEBUG ENV CHECK:', {
  CLIENT_ID: process.env.CLIENT_ID ? '✓ set' : '✗ MISSING',
  CLIENT_SECRET: process.env.CLIENT_SECRET ? '✓ set' : '✗ MISSING',
  TENANT_ID: process.env.TENANT_ID ? '✓ set' : '✗ MISSING',
});

const app = new App({
  plugins: [new DevtoolsPlugin()],
});
// #endregion

// #region Install handler (replaces old membersAdded)
app.on('install.add', async ({ send }) => {
  await send(responses.greeting());
});
// #endregion

// #region Meeting lifecycle event handlers
app.on('meetingStart', async ({ activity, send }) => {
  const meetingId = activity.value?.meetingType;
  console.log(`Meeting started: ${meetingId}`);
  await send('Welcome to **Musical JARVIB**! 🎵 The 3D stage is ready for this meeting.');
});

app.on('meetingEnd', async ({ activity, send }) => {
  console.log('Meeting ended');
  await send('Thanks for using **Musical JARVIB**! See you next time. 🎶');
});

app.on('meetingParticipantJoin', async ({ activity, send }) => {
  const members = activity.value?.members;
  if (members && members.length > 0) {
    const names = members.map((m: any) => m.user?.name || 'Someone').join(', ');
    console.log(`Participant(s) joined: ${names}`);
  }
});

app.on('meetingParticipantLeave', async ({ activity, send }) => {
  const members = activity.value?.members;
  if (members && members.length > 0) {
    const names = members.map((m: any) => m.user?.name || 'Someone').join(', ');
    console.log(`Participant(s) left: ${names}`);
  }
});
// #endregion

// #region Message handler with middleware pattern
// First handler: check for commands
app.on('message', async ({ activity, send, next }) => {
  const text = activity.text?.trim();

  if (text === '/reset') {
    const conversationId = activity.conversation.id;
    conversationStates.delete(conversationId);
    conversationMessages.delete(conversationId);
    socketapp.emit('execute code', "location.reload(true);");
    await send(responses.reset());
    return;
  }

  if (text === '/fullcode') {
    const state = getOrCreateState(activity.conversation.id);
    await send(state.fullCode || "No code generated yet.");
    return;
  }

  if (text === '/test') {
    return;
  }

  // Fall through to AI handler
  next();
});

// Second handler: AI-powered conversation with function calling
app.on('message', async ({ activity, send, log }) => {
  const conversationId = activity.conversation.id;
  const state = getOrCreateState(conversationId);
  const messages = getOrCreateMessages(conversationId);

  if (!state.greeted) {
    state.greeted = true;
  }

  const model = new OpenAIChatModel({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
    model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME!,
  });

  const prompt = new ChatPrompt({
    instructions: buildInstructions(state),
    model,
    messages,
  })
    // Function: Execute Babylon.js code
    .function(
      'codeToExecute',
      'Returns the Babylon.js JavaScript code matching the user intent',
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The JavaScript code to execute next',
          },
        },
        required: ['code'],
      },
      async ({ code }: { code: string }) => {
        if (code) {
          socketapp.emit('execute code', code);
          state.fullCode += code + "\n";
        }
        log.info('codeToExecute', code);
        await send(`<pre>${code}</pre>`);
        return 'Code executed successfully';
      }
    )
    // Function: List available 3D models
    .function(
      'listAvailableModel',
      'List the available 3D models we can load from the library',
      {
        type: 'object',
        properties: {
          nameOfTheModel: {
            type: 'string',
            description: 'The name of the model to search inside the library',
          },
        },
        required: ['nameOfTheModel'],
      },
      async ({ nameOfTheModel }: { nameOfTheModel: string }) => {
        const modelName = nameOfTheModel;
        const jsonRequest = {
          type: "Search",
          pageSize: 5,
          query: modelName,
          parameters: { firstpartycontent: false, app: "office" },
          descriptor: { "$type": "FirstPartyContentSearchDescriptor" },
        };

        const response = await fetch(
          'https://hubble.officeapps.live.com/mediasvc/api/media/search?v=1&lang=en-us',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jsonRequest),
          }
        );
        const content = await response.json();

        let items: Item[] = [];

        if (content.Result && content.Result.PartGroups.length > 0) {
          state.list = [];
          state.fullList = [];

          const results = content.Result.PartGroups;
          results.forEach((value: any) => {
            const image = value.ImageParts[0].SourceUrl;
            let title: string | undefined;
            let url: string | undefined;
            value.TextParts.forEach((textPart: any) => {
              if (textPart.TextCategory === "Title") {
                title = textPart.Text;
              }
              if (textPart.TextCategory === "OasisGlbLink") {
                url = textPart.Text;
              }
            });
            if (title && url && image) {
              state.list.push(title);
              items.push({ name: title, imageUrl: image });
              state.fullList.push({ name: title, imageUrl: image, modelUrl: url });
            }
          });

          // Build adaptive card using typed constructors
          const cardElements: any[] = [
            new TextBlock("Available models", { size: "Large", weight: "Bolder" }),
            ...items.flatMap((item) => [
              new TextBlock(`* ${item.name}`),
              new CardImage(item.imageUrl, { width: "100px" }),
            ]),
          ];

          const card = new AdaptiveCard(...cardElements).withVersion('1.5');
          await send(card);
          return 'We found available models, you can stop there';
        } else {
          return 'No model found, try to find another one closer to the requested name';
        }
      }
    )
    // Function: Load a 3D model
    .function(
      'loadThisModel',
      'Load the 3D model specified by the user',
      {
        type: 'object',
        properties: {
          nameOfTheModel: {
            type: 'string',
            description: 'The name of the model to load from the library',
          },
        },
        required: ['nameOfTheModel'],
      },
      async ({ nameOfTheModel }: { nameOfTheModel: string }) => {
        const modelsList = state.list;
        let index: number;

        if (!isNaN(Number.parseInt(nameOfTheModel))) {
          index = Number.parseInt(nameOfTheModel);
        } else {
          index = modelsList.indexOf(nameOfTheModel);
        }

        if (index >= 0) {
          const modelToLoad = state.fullList[index];
          const fullUrl = modelToLoad.modelUrl;
          const lastSlash = fullUrl.lastIndexOf("/");
          const baseUrl = fullUrl.substring(0, lastSlash + 1);
          const fileName = fullUrl.substring(lastSlash + 1, fullUrl.length);
          const code = `BABYLON.SceneLoader.ImportMesh("", "${baseUrl}", "${fileName}", scene, function (newMeshes) {
          newMeshes[0].name = "${modelsList[index]}";
          newMeshes[0].scaling = new BABYLON.Vector3(30, 30, 30);
      });`;
          await send(responses.itemFound(modelsList[index], code));
          socketapp.emit('execute code', code);
          state.fullCode += code + "\n";
          state.lastModelLoaded = modelsList[index];
          return state.lastModelLoaded + ' model successfully loaded, you can stop there';
        } else {
          await send(responses.itemNotFound(nameOfTheModel));
          return 'No model found, try to find another one closer to the concept of the request one';
        }
      }
    )
    // Function: Transform music note to 3D object
    .function(
      'transformMusicNote',
      'Transform a music note to a JavaScript code that creates a 3D object',
      {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: 'The name of the music note to transform into code. Values: do, re, mi, fa, sol, la, si',
          },
        },
        required: ['note'],
      },
      async ({ note }: { note: string }) => {
        handleMusicNote(note);
        return 'Generated a new object from the note ' + note;
      }
    );

  // Send typing indicator then send message to LLM
  await send({ type: 'typing' });
  const result = await prompt.send(activity.text);

  if (result.content) {
    // Auto-detect JavaScript code blocks in the response and execute them
    const codeBlocks = extractJavaScriptCode(result.content);
    if (codeBlocks.length > 0) {
      const combinedCode = codeBlocks.join("\n");
      socketapp.emit('execute code', combinedCode);
      state.fullCode += combinedCode + "\n";
      log.info('Auto-executed code from response');
    }

    const response = new MessageActivity(result.content).addAiGenerated();
    await send(response);
  }
});
// #endregion

// #region Music note handler (extracted for reuse from socket.io)
function handleMusicNote(note: string) {
  switch (note) {
    case 'do':
      socketapp.emit('execute code', `
              var sphere = BABYLON.MeshBuilder.CreateSphere("sphere", {diameter: 1, segments: 32}, scene);
              sphereMat1 = new BABYLON.PBRMaterial("sphereMat1", scene);
              sphereMat1.albedoColor = new BABYLON.Color3(0.8,0.5,0.5);
              sphereMat1.roughness = 0.4;
              sphereMat1.metallic = 1;
              sphere.material = sphereMat1;
              sphere.position.y = getRandomNumber();
              sphere.position.x = getRandomNumber();
              sphere.position.z = getRandomNumber();
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: sphere.position.x });
              keyFrames.push({ frame: 30, value: sphere.position.x + 1 });
              keyFrames.push({ frame: 45, value: sphere.position.x + 2 });
              keyFrames.push({ frame: 60, value: sphere.position.x + 1 }); 
              keyFrames.push({ frame: 75, value: sphere.position.x }); 
              var bounceAnimation = new BABYLON.Animation("bounceAnimation","position.x",30,BABYLON.Animation.ANIMATIONTYPE_FLOAT,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
              bounceAnimation.setKeys(keyFrames);
              sphere.animations = [bounceAnimation];
              scene.beginAnimation(sphere, 0, 75, true);
              `);
      break;
    case 're':
      socketapp.emit('execute code', `
              var sphere = BABYLON.MeshBuilder.CreateSphere("sphere", {diameter: 1, segments: 32}, scene);
              sphereMat2 = new BABYLON.PBRMaterial("sphereMat2", scene);
              sphereMat2.albedoColor = new BABYLON.Color3(0.5,0.8,0.5);
              sphereMat2.roughness = 0.4;
              sphereMat2.metallic = 1;
              sphere.material = sphereMat2;
              sphere.position.y = getRandomNumber();
              sphere.position.x = getRandomNumber();
              sphere.position.z = getRandomNumber();
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: sphere.position.z });
              keyFrames.push({ frame: 30, value: sphere.position.z + 1 });
              keyFrames.push({ frame: 45, value: sphere.position.z + 2 });
              keyFrames.push({ frame: 60, value: sphere.position.z + 1 }); 
              keyFrames.push({ frame: 75, value: sphere.position.z }); 
              var bounceAnimation = new BABYLON.Animation("bounceAnimation","position.z",30,BABYLON.Animation.ANIMATIONTYPE_FLOAT,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
              bounceAnimation.setKeys(keyFrames);
              sphere.animations = [bounceAnimation];
              scene.beginAnimation(sphere, 0, 75, true);
              `);
      break;
    case 'mi':
      socketapp.emit('execute code', `
              var icosphere = BABYLON.MeshBuilder.CreateIcoSphere("bouleAFacettes")
              var icopbr = new BABYLON.PBRMetallicRoughnessMaterial("icopbr", scene);
              icosphere.material = icopbr;
              icopbr.baseColor = new BABYLON.Color3(1.0, 0.766, 0.336);
              icopbr.metallic = 1.0;
              icopbr.roughness = 0.0;
              icopbr.environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData("https://playground.babylonjs.com/textures/environment.dds", scene);
              icosphere.position.y = getRandomNumber();
              icosphere.position.x = getRandomNumber();
              icosphere.position.z = getRandomNumber();
              var bounceAnimation = new BABYLON.Animation("bounceAnimation","scaling",30,BABYLON.Animation.ANIMATIONTYPE_VECTOR3,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: new BABYLON.Vector3(1, 1, 1) });
              keyFrames.push({ frame: 30, value: new BABYLON.Vector3(0.5, 0.5, 0.5) });
              keyFrames.push({ frame: 60, value: new BABYLON.Vector3(1, 1, 1) });
              bounceAnimation.setKeys(keyFrames);
              icosphere.animations = [bounceAnimation];
              scene.beginAnimation(icosphere, 0, 60, true);
              `);
      break;
    case 'fa':
      socketapp.emit('execute code', `
        var icosphere = BABYLON.MeshBuilder.CreateGoldberg("icosphere", {radius: 1, radiusScale: 0.5, subdivisions: 4}, scene);
        sphereMat3 = new BABYLON.PBRMaterial("sphereMat3", scene);
        sphereMat3.albedoColor = new BABYLON.Color3(0.8,0.5,0.8);
        sphereMat3.roughness = 0.4;
        sphereMat3.metallic = 1;
        icosphere.material = sphereMat3;    
        icosphere.position.y = getRandomNumber();
        icosphere.position.x = getRandomNumber();
        icosphere.position.z = getRandomNumber();
        var rotationAnimation = new BABYLON.Animation("rotationAnimation","rotation",30,BABYLON.Animation.ANIMATIONTYPE_VECTOR3,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
        var keyFrames = [];
        keyFrames.push({ frame: 0, value: new BABYLON.Vector3(0, 0, 0) });
        keyFrames.push({ frame: 60, value: new BABYLON.Vector3(Math.PI, Math.PI, 0) });
        rotationAnimation.setKeys(keyFrames);
        icosphere.animations = [rotationAnimation];
        scene.beginAnimation(icosphere, 0, 60, true);
        `);
      break;
    case 'sol':
      socketapp.emit('execute code', `
        var icosphere = BABYLON.MeshBuilder.CreateGoldberg("icosphere", {radius: 1, radiusScale: 0.5, subdivisions: 4}, scene);
        sphereMat2 = new BABYLON.PBRMaterial("sphereMat2", scene);
        sphereMat2.albedoColor = new BABYLON.Color3(0.5,0.8,0.5);
        sphereMat2.roughness = 0.4;
        sphereMat2.metallic = 1;
        icosphere.material = sphereMat2;    
        icosphere.position.y = getRandomNumber();
        icosphere.position.x = getRandomNumber();
        icosphere.position.z = getRandomNumber();
        var rotationAnimation = new BABYLON.Animation("rotationAnimation","rotation",30,BABYLON.Animation.ANIMATIONTYPE_VECTOR3,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
        var keyFrames = [];
        keyFrames.push({ frame: 0, value: new BABYLON.Vector3(0, 0, 0) });
        keyFrames.push({ frame: 60, value: new BABYLON.Vector3(Math.PI, Math.PI, 0) });
        rotationAnimation.setKeys(keyFrames);
        icosphere.animations = [rotationAnimation];
        scene.beginAnimation(icosphere, 0, 60, true);
        `);
      break;
    case 'la':
      socketapp.emit('execute code', `
        var icosphere = BABYLON.MeshBuilder.CreateGoldberg("icosphere", {radius: 1, radiusScale: 0.5, subdivisions: 4}, scene);
        sphereMat1 = new BABYLON.PBRMaterial("sphereMat1", scene);
        sphereMat1.albedoColor = new BABYLON.Color3(0.2,0.5,0.8);
        sphereMat1.roughness = 0.4;
        sphereMat1.metallic = 1;
        icosphere.material = sphereMat1;    
        icosphere.position.y = getRandomNumber();
        icosphere.position.x = getRandomNumber();
        icosphere.position.z = getRandomNumber();
        var rotationAnimation = new BABYLON.Animation("rotationAnimation","rotation",30,BABYLON.Animation.ANIMATIONTYPE_VECTOR3,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
        var keyFrames = [];
        keyFrames.push({ frame: 0, value: new BABYLON.Vector3(0, 0, 0) });
        keyFrames.push({ frame: 60, value: new BABYLON.Vector3(Math.PI, Math.PI, 0) });
        rotationAnimation.setKeys(keyFrames);
        icosphere.animations = [rotationAnimation];
        scene.beginAnimation(icosphere, 0, 60, true);
        `);
      break;
    case 'si':
      socketapp.emit('execute code', `
        var icosphere = BABYLON.MeshBuilder.CreateGoldberg("icosphere", {radius: 1, radiusScale: 0.5, subdivisions: 4}, scene);
        sphereMat3 = new BABYLON.PBRMaterial("sphereMat3", scene);
        sphereMat3.albedoColor = new BABYLON.Color3(0.5,0.5,0.8);
        sphereMat3.roughness = 0.4;
        sphereMat3.metallic = 1;
        icosphere.material = sphereMat3;    
        icosphere.position.y = getRandomNumber();
        icosphere.position.x = getRandomNumber();
        icosphere.position.z = getRandomNumber();
        var rotationAnimation = new BABYLON.Animation("rotationAnimation","rotation",30,BABYLON.Animation.ANIMATIONTYPE_VECTOR3,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
        var keyFrames = [];
        keyFrames.push({ frame: 0, value: new BABYLON.Vector3(0, 0, 0) });
        keyFrames.push({ frame: 60, value: new BABYLON.Vector3(Math.PI, Math.PI, 0) });
        rotationAnimation.setKeys(keyFrames);
        icosphere.animations = [rotationAnimation];
        scene.beginAnimation(icosphere, 0, 60, true);
        `);
      break;
    case 'jurassic':
      socketapp.emit('execute code', `
                  BABYLON.appendSceneAsync("/assets/trex.glb", scene).then(() => {
                      const myMesh = scene.getMeshByName("__root__");
                      myMesh.name = "trex" + trexindice;
                      trexindice++;
                      if (myMesh) {
                          myMesh.scaling.x *= 3;
                          myMesh.scaling.y *= 3;
                          myMesh.scaling.z *= 3;
                      } 
                  });
              `);
      break;
    case 'firework':
      socketapp.emit('execute code', `
            var particleSystem = new BABYLON.ParticleSystem("particles", 2000, scene);
            particleSystem.particleTexture = new BABYLON.Texture("https://playground.babylonjs.com/textures/flare.png", scene);
            particleSystem.emitter = BABYLON.Vector3.Zero();
            particleSystem.minEmitBox = new BABYLON.Vector3(-1, -1, -1);
            particleSystem.maxEmitBox = new BABYLON.Vector3(1, 1, 1);
            particleSystem.color1 = new BABYLON.Color4(0.75, 0.13, 0.21);
            particleSystem.color2 = new BABYLON.Color4(0.88, 1, 0.2);
            particleSystem.colorDead = new BABYLON.Color4(0.16, 0.47, 0.16, 0);
            particleSystem.minSize = 0.1;
            particleSystem.maxSize = 0.5;
            particleSystem.minLifeTime = 0.3;
            particleSystem.maxLifeTime = 1.5;
            particleSystem.emitRate = 1500;
            particleSystem.gravity = new BABYLON.Vector3(0, -9.81, 0);
            particleSystem.direction1 = new BABYLON.Vector3(-7, 8, 3);
            particleSystem.direction2 = new BABYLON.Vector3(7, 8, -3);
            particleSystem.minAngularSpeed = 0;
            particleSystem.maxAngularSpeed = Math.PI;
            particleSystem.minEmitPower = 1;
            particleSystem.maxEmitPower = 3;
            particleSystem.updateSpeed = 0.005;
            particleSystem.start();
            setTimeout(() => { particleSystem.stop(); }, 2000);          
          `);
      break;
    default:
      socketapp.emit('execute code', `
          var sphere = BABYLON.MeshBuilder.CreateSphere("sphere", {diameter: 2, segments: 32}, scene);
          sphere.material = new BABYLON.PBRMaterial('metal', scene);
          sphere.material.roughness = 0.25;
          sphere.material.metallic = 1.0;
          sphere.position.y = getRandomNumber();
          sphere.position.x = getRandomNumber();
          sphere.position.z = getRandomNumber();
          var keyFrames = [];
          keyFrames.push({ frame: 0, value: sphere.position.y });
          keyFrames.push({ frame: 30, value: sphere.position.y + 1 });
          keyFrames.push({ frame: 45, value: sphere.position.y + 2 });
          keyFrames.push({ frame: 60, value: sphere.position.y + 1 }); 
          keyFrames.push({ frame: 75, value: sphere.position.y }); 
          var bounceAnimation = new BABYLON.Animation("bounceAnimation","position.y",30,BABYLON.Animation.ANIMATIONTYPE_FLOAT,BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE);
          bounceAnimation.setKeys(keyFrames);
          sphere.animations = [bounceAnimation];
          scene.beginAnimation(sphere, 0, 75, true);
      `);
      break;
  }
}
// #endregion

// #region Notes mapping
const notesMap = new Map([
  ['A', 'la'], ['B', 'si'], ['C', 'do'], ['D', 're'],
  ['E', 'mi'], ['F', 'fa'], ['G', 'sol'],
  ['A#', 'la#'], ['B#', 'si#'], ['C#', 'do#'], ['D#', 're#'],
  ['E#', 'mi#'], ['F#', 'fa#'], ['G#', 'sol#'],
  ['jurassic', 'jurassic'], ['firework', 'firework'],
]);
// #endregion

// #region Socket.IO streaming helpers
let completeAnswer = "";

async function printStream(sses: any, final: boolean = false) {
  let isThinking = false;
  let socketCodeMessage = 'execute pseudo final code';
  let socketAIAnswerMessage = 'AI Answer';

  if (final) {
    socketCodeMessage = 'execute final code';
    socketAIAnswerMessage = 'AI Answer final';
  }

  for await (const event of sses) {
    if (event.data === "[DONE]") {
      let code = extractJavaScriptCode(completeAnswer);
      if (code[0]) {
        socketapp.emit(socketCodeMessage, code[0]);
      }
      return;
    }
    for (const choice of (JSON.parse(event.data)).choices) {
      const content = choice.delta?.content ?? "";

      if (content === "<think>") {
        isThinking = true;
        process.stdout.write("🧠 Thinking...");
        socketapp.emit(socketAIAnswerMessage, "🧠 Thinking...");
      } else if (content === "</think>") {
        isThinking = false;
        console.log("🛑\n\n");
        socketapp.emit(socketAIAnswerMessage, "🛑\n\n");
      } else if (content) {
        process.stdout.write(content);
        completeAnswer += content;
        socketapp.emit(socketAIAnswerMessage, content.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;'));
      }
    }
  }
}

function extractJavaScriptCode(input: string): string[] {
  const regex = /```javascript([\s\S]*?)```/g;
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(input)) !== null) {
    matches.push(match[1].trim());
  }
  return matches;
}
// #endregion

// #region Socket.IO connection handlers
socketapp.on('connection', (socket: any) => {
  console.log('a user connected');

  socket.on('midi', async (note: string) => {
    console.log('midi note received: ' + note);
    const noteToSend = notesMap.get(note) || note;
    socketapp.emit('midicar', noteToSend);
    handleMusicNote(noteToSend);
  });

  socket.on('pseudofinal', async (noteStream: []) => {
    console.log('pseudofinal notes received: ' + noteStream);

    const response = await azureOpenAIClient.path("/chat/completions").post({
      body: {
        messages: [
          {
            role: "system", content: `You're going to receive a musical notes sequence on the theme of Jurassic Park. Learn about the context of the movie. 

You're an expert in Babylon.js, the JavaScript WebGL 3D engine. 

rules:
- assume there is already an existing Babylon.js scene, engine and camera so you don't have to create them 
- just generate the JavaScript code to add into an existing program.
- use the scene and engine objects directly
- don't try to load a model nor any texture 

Using the notes provided, try to build a complete artistic scene matching the sequence and be inspired by the movie. Each note creates a specific element of the background scene, stay free for the dinosaurs. 

Follow the action movie principles with slow animations. Use the colors, with high contrast and picture style of the movie. The dinosaures must move in a loop on a specific path you will decide.

Build dinosaurs using the Babylon.js primitives, like Lego.`
          },
          { role: "user", content: noteStream.toString() }
        ],
        max_tokens: 4096,
        temperature: 0.75,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: finalModelName,
        stream: true,
      }
    }).asNodeStream();

    completeAnswer = "";
    const sses = createSseStream(<any>response.body);
    printStream(sses);

    if (response.status !== "200") {
      throw (<any>response.body).error;
    }
  });

  socket.on('final', async (noteStream: []) => {
    console.log('FINAL notes received: ' + noteStream);

    const response = await azureOpenAIClient.path("/chat/completions").post({
      body: {
        messages: [
          {
            role: "system", content: `You're an expert in Babylon.js, the JavaScript WebGL 3D engine. 

rules:
- assume there is already an existing Babylon.js scene, engine and camera so you don't have to create them 
- assume there is already a ground created to welcome the meshes and a light, you don't need to create one
- place the models defined in the below JSON inside those square coordinates -50 by 50
- place the gate at the center
- place at least 15 trees on the floor, Y=0
- place at least 50 dinosaurs on the floor
- don't generate any fog
- just generate the JavaScript code to add into an existing program.
- use the scene and engine objects directly
- look at the below list of models, use a much models as possible and their JSON characteristics to build the scene accordingly
- if it can move, animated its position on screen, otherwise just load it somewhere on a fix position
- if it can fly, animated its position in the air, not higher than Y=8
- if the size property is different from 1, use it to scale the model with the value provided
- play in loop the musical sequence received using Web Audio API
- use the notes to change the color of an animated spotlight
- be creative using basic primitives to generate some background, vegetation, rocks

Follow the action movie principles with slow animations. Use the colors, with high contrast and picture style of the movie. The dinosaures that are allowed to move must move in a loop on a specific path you will decide.

List of models:
{
    "dinosaurs": {
        "predators": [
            {
                "name": "Tyrannosaurus Rex",
                "url": "https://david.blob.core.windows.net/tests/001_animated_t-rex.glb",
                "description": "It is one of the most well-known and aggressive predators.",
                "canMove": true,
                "size": 1
            },
            {
                "name": "Velociraptor",
                "url": "https://david.blob.core.windows.net/tests/006_raptor_blue.glb",
                "description": "It is a small and fast predator.",
                "canMove": false,
                "size": 1
            },
            {
                "name": "Velociraptor animated",
                "url": "https://david.blob.core.windows.net/tests/007_animatedvelociraptor.glb",
                "description": "It is a small and fast predator.",
                "canMove": false,
                "size": 10
            },
            {
                "name": "Pteradactyl",
                "url": "https://david.blob.core.windows.net/tests/003_animated_flying_pteradactal_dinosaur.glb",
                "description": "It is a flying predator.",
                "canMove": true,
                "canFly": true,
                "size": 1
            },
            {
                "name": "Pteranodon",
                "url": "https://david.blob.core.windows.net/tests/008_flyingpteranodon.glb",
                "description": "It is another flying predator.",
                "canMove": true,
                "canFly": true,
                "size": 1
            },
            {
                "name": "quetzalcoatlus",
                "url": "https://david.blob.core.windows.net/tests/010_flying_quetzalcoatlus.glb",
                "description": "It is another flying predator.",
                "canMove": true,
                "canFly": true,
                "size": 0.75
            }
        ],
        "preys": [
            {
                "name": "Diplodocus",
                "url": "https://david.blob.core.windows.net/tests/004_mamen_river_dragon.glb",
                "description": "It is a herbivore dinosaur.",
                "canMove": false,
                "size": 1
            },
            {
                "name": "protoceratops",
                "url": "https://david.blob.core.windows.net/tests/005_protoceratops.glb",
                "description": "It is a herbivore dinosaur.",
                "canMove": false,
                "size": 0.5
            },
            {
                "name": "Triceratops",
                "url": "https://david.blob.core.windows.net/tests/009_triceratop.glb",
                "description": "It is a herbivore dinosaur.",
                "canMove": false,
                "size": 0.75
            },
            {
                "name": "Ankylosaurus",
                "url": "https://david.blob.core.windows.net/tests/011_ankylosaur.glb",
                "description": "It is a herbivore dinosaur.",
                "canMove": false,
                "size": 5
            }
        ]
    },
    "gate": {
        "url": "https://david.blob.core.windows.net/tests/012_jurassic_park_gate.glb",
        "description": "The famous Jurassic Park gate.",
        "canMove": false,
        "size": 0.01
    },
    "trees": [
        {
            "url": "https://david.blob.core.windows.net/tests/013_acacia_tree.glb",
            "description": "A tree model medium height.",
            "canMove": false,
            "size": 1
        },
        {
            "url": "https://david.blob.core.windows.net/tests/014_realistic_tree.glb",
            "description": "Another tree model for the dinosaurs, higher than the previous one.",
            "canMove": false,
            "size": 1
        }
    ]
}`
          },
          { role: "user", content: noteStream.toString() }
        ],
        max_tokens: 4096,
        temperature: 0.7,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: finalModelName,
        stream: true,
      }
    }).asNodeStream();

    completeAnswer = "";
    const sses = createSseStream(<any>response.body);
    printStream(sses, true);

    if (response.status !== "200") {
      console.error((<any>response.body).error);
    }
  });
});
// #endregion

// Start the app
(async () => {
  await app.start();
  console.log('Musical JARVIB is running!');
})();
