import { CardFactory, MemoryStorage, MessageFactory, TurnContext } from "botbuilder";
import * as path from "path";
import config from "../config";
import axios from 'axios';

import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { createSseStream } from "@azure/core-sse";

const endpoint = "https://yourid.openai.azure.com/openai/deployments/gpt-4o";
const finalModelName = "gpt-4o"; 

// See https://aka.ms/teams-ai-library to learn more about the Teams AI library.
import {
  AI, Application, ActionPlanner, OpenAIModel, PromptManager, TurnState, DefaultConversationState,
  DefaultUserState, DefaultTempState, Memory
} from "@microsoft/teams-ai"; 

import * as responses from '../responses'; 
import { forEach } from 'lodash';
import socketapp from "./socketapp"; 

// #region Boring Interafaces region
// Strongly type the applications turn state
interface fullListItem {
  name: string;
  imageUrl: string;
  modelUrl: string;
}
interface ConversationState extends DefaultConversationState {
  greeted: boolean;
  fullList: fullListItem[];
  imageList: string[];
  list: string[];
  lastModelLoaded: string;
  fullCode: string;
}

type UserState = DefaultUserState;

interface TempState extends DefaultTempState {
  fullList: fullListItem[];
  imageList: string[];
  list: string[];
}

// Define an interface to strongly type data parameters for actions
interface GetModel {
  nameOfTheModel: string; // <- populated by GPT
}

// Define an interface to strongly type data parameters for actions
interface GetCode {
  code: string; // <- populated by GPT
}

interface GetNote {
  note: string; // <- populated by GPT
}

interface Item {
  name: string;
  imageUrl: string;
}

interface TextBlock {
  type: "TextBlock";
  text: string;
  weight?: "bolder";
  size?: "large";
}

interface Image {
  type: "Image";
  url: string;
  width: string;
  horizontalAlignment: "left";
}

interface Container {
  type: "Container";
  items: (TextBlock | Image)[];
}

interface AdaptiveCard {
  $schema: string;
  version: string;
  type: "AdaptiveCard";
  body: (TextBlock | Container)[];
}
// #endregion

type ApplicationTurnState = TurnState<ConversationState, UserState, TempState>;

// Use to have a standalone separate client to call the Azure OpenAI API directly
const azureOpenAIClient = ModelClient(endpoint, new AzureKeyCredential(config.azureOpenAIKey));
 
// Create AI components
const model = new OpenAIModel({
  azureApiKey: config.azureOpenAIKey,
  azureDefaultDeployment: config.azureOpenAIDeploymentName,
  azureEndpoint: config.azureOpenAIEndpoint,

  useSystemMessages: true,
  logRequests: true,
});

const prompts = new PromptManager({
  promptsFolder: path.join(__dirname, "../prompts"),
});
const planner = new ActionPlanner({
  model,
  prompts,
  defaultPrompt: "chat",
});

// Define storage and application
const storage = new MemoryStorage();
const app = new Application({
  storage,
  ai: {
    planner,
    enable_feedback_loop: true,
  },
});

app.feedbackLoop(async (context, state, feedbackLoopData) => {
  //add custom feedback process logic here
  console.log("Your feedback is " + JSON.stringify(context.activity.value));
});

// Define a prompt function for getting the current status of the lights
planner.prompts.addFunction('getModelsList', async (context: TurnContext, memory: Memory) => {
  return memory.getValue('conversation.list');
});

planner.prompts.addFunction('getLastModelLoaded', async (context: TurnContext, memory: Memory) => {
  return memory.getValue('conversation.lastModelLoaded');
});

planner.prompts.addFunction('getFullCode', async (context: TurnContext, memory: Memory) => {
  return memory.getValue('conversation.fullCode');
});

// Listen for new members to join the conversation
app.conversationUpdate('membersAdded', async (context: TurnContext, state: ApplicationTurnState) => {
  if (!state.conversation.greeted) {
    state.conversation.greeted = true;
    await context.sendActivity(responses.greeting());
  }
});

// List for /reset command, then delete the conversation state, clean the object
// and reload the page containing the 3D canvas to start from scratch
app.message('/reset', async (context: TurnContext, state: ApplicationTurnState) => {
  state.deleteConversationState();
  state.conversation.list = [];
  state.conversation.fullList = [];
  state.conversation.imageList = [];
  state.conversation.lastModelLoaded = "";
  state.conversation.fullCode = "";
  socketapp.emit('execute code', "location.reload(true);");
  await context.sendActivity(responses.reset());
});

// List for /describe command to visually describe the complete scene to someone who is blind
app.message('/test', async (context: TurnContext, state: ApplicationTurnState) => {
  //await app.ai.doAction(context, state, 'codeToExecute', { code: "alert('A scene with a sphere and a cube')" }); 
  // context.
  // app.run(context);
});

// List for /fullcode to return all the code generated so far by the bot if you want to copy it
app.message('/fullcode', async (context: TurnContext, state: ApplicationTurnState) => {
  await context.sendActivity(state.conversation.fullCode);
}); 

// Register action handlers
app.ai.action('codeToExecute', async (context: TurnContext, state: ApplicationTurnState, codeToExecute: GetCode) => {
  let code = "";
  if (codeToExecute && codeToExecute.code) {
    code = codeToExecute.code;
    socketapp.emit('execute code', code);
    state.conversation.fullCode += code + "\n";
  };
  console.dir(codeToExecute.code);
  await context.sendActivity(`<pre>${codeToExecute.code}</pre>`);

  return '';
});

app.ai.action('listAvailableModel', async (context: TurnContext, state: ApplicationTurnState, model: GetModel) => {
  console.dir(model);
  var modelName = model.nameOfTheModel ?? (<any>model).model;
  var jsonRequest =
  {
    "type": "Search",
    "pageSize": 5,
    "query": modelName,
    "parameters": { "firstpartycontent": false, "app": "office" },
    "descriptor": { "$type": "FirstPartyContentSearchDescriptor" }
  }
  // create a POST request to the server with a JSON parameter 
  // that contains the model name
  const response = await fetch('https://hubble.officeapps.live.com/mediasvc/api/media/search?v=1&lang=en-us', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(jsonRequest)
  });
  const content = await response.json();

  let items: Item[] = [];

  if (content.Result && content.Result.PartGroups.length > 0) {
    state.conversation.list = [];
    state.conversation.fullList = [];
    state.conversation.imageList = [];
    var list = state.conversation.list;
    var fullList = state.conversation.fullList;
    //var imageList = state.conversation.imageList;

    var results = content.Result.PartGroups;
    forEach(results, function (value) {
      var image = value.ImageParts[0].SourceUrl;
      var title;
      var url;
      forEach(value.TextParts, function (text) {
        if (text.TextCategory == "Title") {
          title = text.Text;
        }
        if (text.TextCategory == "OasisGlbLink") {
          url = text.Text;
        }
      });
      if (title && url && image) {
        // imageList.push(image);  
        list.push(title);
        items.push({ name: title, imageUrl: image })
        fullList.push({ name: title, imageUrl: image, modelUrl: url });
      }
    });

    const adaptiveCardSchema: AdaptiveCard = {
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "version": "1.3",
      "type": "AdaptiveCard",
      "body": [
        {
          "type": "TextBlock",
          "text": "Available models",
          "weight": "bolder",
          "size": "large"
        },
        {
          "type": "Container",
          "items": []
        }
      ]
    };

    function insertItems(schema: AdaptiveCard, items: Item[]): void {
      const container = schema.body.find(element => element.type === "Container") as Container;
      if (!container) {
        console.error('Container element not found in the schema');
        return;
      }

      container.items = []; // Clear existing items

      items.forEach(item => {
        // Add TextBlock for the item name
        container.items.push({
          "type": "TextBlock",
          "text": `* ${item.name}`
        });

        // Add Image for the item
        container.items.push({
          "type": "Image",
          "url": item.imageUrl,
          "width": "100px",
          "horizontalAlignment": "left"
        });
      });
    }

    // Call the function to insert items
    insertItems(adaptiveCardSchema, items);

    // Log the modified schema to see the result
    console.log(JSON.stringify(adaptiveCardSchema, null, 2));

    const attachment = CardFactory.adaptiveCard(adaptiveCardSchema);
    await context.sendActivity(MessageFactory.attachment(attachment));
    return 'We found available models, you can stop there';
  }
  else {
    return 'No model found, try to find another one closer to the requested name';
  }
});

app.ai.action('loadThisModel', async (context: TurnContext, state: ApplicationTurnState, model: GetModel) => {
  const modelsList = state.conversation.list;
  var modelName = model.nameOfTheModel ?? (<any>model).model;
  let index: number;
  // If the user would like to load a specific model via its index in the list
  if (!isNaN(Number.parseInt(modelName))) {
    index = Number.parseInt(modelName);
  }
  // Otherwise, we look for the model name in the list        
  else {
    index = modelsList.indexOf(modelName);
  }
  // If the model is found, we load it
  if (index >= 0) {
    var modelToLoad = state.conversation.fullList[index];
    var fullUrl = modelToLoad.modelUrl;
    let lastSlash = fullUrl.lastIndexOf("/");
    let baseUrl = fullUrl.substring(0, lastSlash + 1);
    let fileName = fullUrl.substring(lastSlash + 1, fullUrl.length);
    var code = `BABYLON.SceneLoader.ImportMesh("", "${baseUrl}", "${fileName}", scene, function (newMeshes) {
          newMeshes[0].name = "${modelsList[index]}";
          newMeshes[0].scaling = new BABYLON.Vector3(30, 30, 30);
      });`;
    await context.sendActivity(responses.itemFound(modelsList[index], code));
    socketapp.emit('execute code', code);
    state.conversation.fullCode += code + "\n";
    state.conversation.lastModelLoaded = modelsList[index];
    return state.conversation.lastModelLoaded + ' model successfully loaded, you can stop there';
  } else {
    await context.sendActivity(responses.itemNotFound(modelName));
    return 'No model found, try to find another one closer to the concept of the request one';
  }
});

app.ai.action('transformMusicNote', async (context: TurnContext, state: ApplicationTurnState, receivedNote: GetNote) => {
  var noteReceived: any = receivedNote.note ?? receivedNote;
  var note = noteReceived ?? noteReceived.nameOfTheNote;

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

              // Define the keyframes for the animation
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: sphere.position.x });
              keyFrames.push({ frame: 30, value: sphere.position.x + 1 }); // Bounce up
              keyFrames.push({ frame: 45, value: sphere.position.x + 2 }); // Return to original position
              keyFrames.push({ frame: 60, value: sphere.position.x + 1 }); 
              keyFrames.push({ frame: 75, value: sphere.position.x }); 

              // Create a bouncing animation
              var bounceAnimation = new BABYLON.Animation(
                  "bounceAnimation",
                  "position.x",
                  30, // Frames per second
                  BABYLON.Animation.ANIMATIONTYPE_FLOAT,
                  BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
              );

              bounceAnimation.setKeys(keyFrames);

              // Attach the animation to the sphere
              sphere.animations = [bounceAnimation];

              // Start the animation
              scene.beginAnimation(sphere, 0, 75, true);
              `
      );
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

              // Define the keyframes for the animation
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: sphere.position.z });
              keyFrames.push({ frame: 30, value: sphere.position.z + 1 }); // Bounce up
              keyFrames.push({ frame: 45, value: sphere.position.z + 2 }); // Return to original position
              keyFrames.push({ frame: 60, value: sphere.position.z + 1 }); 
              keyFrames.push({ frame: 75, value: sphere.position.z }); 

              // Create a bouncing animation
              var bounceAnimation = new BABYLON.Animation(
                  "bounceAnimation",
                  "position.z",
                  30, // Frames per second
                  BABYLON.Animation.ANIMATIONTYPE_FLOAT,
                  BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
              );

              bounceAnimation.setKeys(keyFrames);

              // Attach the animation to the sphere
              sphere.animations = [bounceAnimation];

              // Start the animation
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

              var bounceAnimation = new BABYLON.Animation(
                  "bounceAnimation",
                  "scaling",
                  30, // Frames per second
                  BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
                  BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
              );

              // Define the keyframes for the animation
              var keyFrames = [];
              keyFrames.push({ frame: 0, value: new BABYLON.Vector3(1, 1, 1) });
              keyFrames.push({ frame: 30, value: new BABYLON.Vector3(0.5, 0.5, 0.5) }); // Bounce up
              keyFrames.push({ frame: 60, value: new BABYLON.Vector3(1, 1, 1) }); // Return to original position
              
              bounceAnimation.setKeys(keyFrames);

              // Attach the animation to the sphere
              icosphere.animations = [bounceAnimation];

              // Start the animation
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

        // Add rotation animation
        var rotationAnimation = new BABYLON.Animation(
          "rotationAnimation",
          "rotation",
          30, // Frames per second
          BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
          BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
        );

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

        // Add rotation animation
        var rotationAnimation = new BABYLON.Animation(
          "rotationAnimation",
          "rotation",
          30, // Frames per second
          BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
          BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
        );

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

        // Add rotation animation
        var rotationAnimation = new BABYLON.Animation(
          "rotationAnimation",
          "rotation",
          30, // Frames per second
          BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
          BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
        );

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

          // Add rotation animation
          var rotationAnimation = new BABYLON.Animation(
            "rotationAnimation",
            "rotation",
            30, // Frames per second
            BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
            BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
          );

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
            // Create a particle system
            var particleSystem = new BABYLON.ParticleSystem("particles", 2000, scene);

            //Texture of each particle
            particleSystem.particleTexture = new BABYLON.Texture("https://playground.babylonjs.com/textures/flare.png", scene);

            // Where the particles come from
            particleSystem.emitter = BABYLON.Vector3.Zero(); // the starting position
            particleSystem.minEmitBox = new BABYLON.Vector3(-1, -1, -1); // Bottom Left Front
            particleSystem.maxEmitBox = new BABYLON.Vector3(1, 1, 1); // Top Right Back

            // Colors of all particles
            particleSystem.color1 = new BABYLON.Color4(0.75, 0.13, 0.21);
            particleSystem.color2 = new BABYLON.Color4(0.88, 1, 0.2);
            particleSystem.colorDead = new BABYLON.Color4(0.16, 0.47, 0.16, 0);

            // Size of each particle (random between...
            particleSystem.minSize = 0.1;
            particleSystem.maxSize = 0.5;

            // Life time of each particle (random between...
            particleSystem.minLifeTime = 0.3;
            particleSystem.maxLifeTime = 1.5;

            // Emission rate
            particleSystem.emitRate = 1500;

            // Set the gravity of all particles
            particleSystem.gravity = new BABYLON.Vector3(0, -9.81, 0);

            // Direction of each particle after it has been emitted
            particleSystem.direction1 = new BABYLON.Vector3(-7, 8, 3);
            particleSystem.direction2 = new BABYLON.Vector3(7, 8, -3);

            // Angular speed, in radians
            particleSystem.minAngularSpeed = 0;
            particleSystem.maxAngularSpeed = Math.PI;

            // Speed
            particleSystem.minEmitPower = 1;
            particleSystem.maxEmitPower = 3;
            particleSystem.updateSpeed = 0.005;

            // Start the particle system
            particleSystem.start();

            setTimeout(() => {
                particleSystem.stop();
            }, 2000);          
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

          // Define the keyframes for the animation
          var keyFrames = [];
          keyFrames.push({ frame: 0, value: sphere.position.y });
          keyFrames.push({ frame: 30, value: sphere.position.y + 1 }); // Bounce up
          keyFrames.push({ frame: 45, value: sphere.position.y + 2 }); // Return to original position
          keyFrames.push({ frame: 60, value: sphere.position.y + 1 }); 
          keyFrames.push({ frame: 75, value: sphere.position.y }); 

          // Create a bouncing animation
          var bounceAnimation = new BABYLON.Animation(
              "bounceAnimation",
              "position.y",
              30, // Frames per second
              BABYLON.Animation.ANIMATIONTYPE_FLOAT,
              BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
          );

          bounceAnimation.setKeys(keyFrames);

          // Attach the animation to the sphere
          sphere.animations = [bounceAnimation];

          // Start the animation
          scene.beginAnimation(sphere, 0, 75, true);
      `);
      break;
  }
  return 'Generate a new object from the note ' + note;
});

// Register a handler to handle unknown actions that might be predicted
app.ai.action(
  AI.UnknownActionName,
  async (context: TurnContext, state: ApplicationTurnState, data: GetCode, action?: string) => {
    await context.sendActivity(responses.unknownAction(action!));
    return 'Sorry, this is an unknown action available';
  }
);

let localContext: TurnContext;
var completeAnswer;

const notesMap = new Map([
  ['A', 'la'],
  ['B', 'si'],
  ['C', 'do'],
  ['D', 're'],
  ['E', 'mi'],
  ['F', 'fa'],
  ['G', 'sol'],
  ['A#', 'la#'],
  ['B#', 'si#'],
  ['C#', 'do#'],
  ['D#', 're#'],
  ['E#', 'mi#'],
  ['F#', 'fa#'],
  ['G#', 'sol#'],
  ['jurassic', 'jurassic'],
  ['firework', 'firework']
]);

socketapp.on('connection', (socket: any) => {
  console.log('a user connected');

  socket.on('midi', async (note: string) => {
    console.log('midi note received' + note);
    var noteToSend: GetNote = { note: <string>notesMap.get(note) };
    socketapp.emit('midicar', noteToSend.note);
    app.ai.doAction(localContext, <ApplicationTurnState><unknown>undefined, 'transformMusicNote', noteToSend);
  })

  socket.on('pseudofinal', async (noteStream: []) => {
    console.log('pseudofinal notes received: ' + noteStream);

    var response = await azureOpenAIClient.path("/chat/completions").post({
      body: {
        messages: [
          { role:"system", content: `You're going to receive a musical notes sequence on the theme of Jurassic Park. Learn about the context of the movie. 

You're an expert in Babylon.js, the JavaScript WebGL 3D engine. 

rules:
- assume there is already an existing Babylon.js scene, engine and camera so you don't have to create them 
- just generate the JavaScript code to add into an existing program.
- use the scene and engine objects directly
- don't try to load a model nor any texture 

Using the notes provided, try to build a complete artistic scene matching the sequence and be inspired by the movie. Each note creates a specific element of the background scene, stay free for the dinosaurs. 

Follow the action movie principles with slow animations. Use the colors, with high contrast and picture style of the movie. The dinosaures must move in a loop on a specific path you will decide.

Build dinosaurs using the Babylon.js primitives, like Lego.` },
          { role:"user", content: noteStream.toString() }
        ],
        max_tokens: 4096,
        temperature: 0.75,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: finalModelName,
        stream: true
      }
    }).asNodeStream();

    completeAnswer = "";

    var sses = createSseStream(<any>response.body);
    printStream(sses);
  
    if (response.status !== "200") {
      throw (<any>response.body).error;
    }
  });

  socket.on('final', async (noteStream: []) => {
    console.log('FINAL notes received: ' + noteStream);

    var response = await azureOpenAIClient.path("/chat/completions").post({
      body: {
        messages: [
          { role:"system", content: `You're an expert in Babylon.js, the JavaScript WebGL 3D engine. 

rules:
- assume there is already an existing Babylon.js scene, engine and camera so you don't have to create them 
- assume there is already a ground created to welcome the meshes and a light, you don’t need to create one
- place the models defined in the below JSON inside those square coordinates -50 by 50
- place the gate at the center
- place at least 15 trees on the floor, Y=0
- place at least 50 dinosaurs on the floor
- don’t generate any fog
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
}` },
          { role:"user", content: noteStream.toString() }
        ],
        max_tokens: 4096,
        temperature: 0.7,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: finalModelName,
        stream: true 
      }
    }).asNodeStream();

    completeAnswer = "";

    var sses = createSseStream(<any>response.body);
    printStream(sses, true);
   
    if (response.status !== "200") {
      console.error((<any>response.body).error);
    }
  });
});

async function printStream(sses, final: boolean = false) { 
  let isThinking = false;
  let socketCodeMessage = 'execute pseudo final code';
  let socketAIAnswerMessage = 'AI Answer';

  if (final) {
    socketCodeMessage = 'execute final code';
    socketAIAnswerMessage = 'AI Answer final';
  }
  
  for await (const event of sses) {
      if (event.data === "[DONE]") {
          //console.log(completeAnswer); 

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

              // Send properly formatted content over WebSocket
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

export default app;
