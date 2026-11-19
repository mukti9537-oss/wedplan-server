import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import 'dotenv/config'

const app = express();
const port = process.env.PORT || 8000;

//middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-sed4pgj-shard-00-00.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-01.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-02.la1zoji.mongodb.net:27017/?ssl=true&replicaSet=atlas-sjdwaf-shard-0&authSource=admin`);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
const connectedClient = await connectToMongoDB()
const database = connectedClient.db('wedplan');
const users = database.collection("user");

app.get('/', (req, res) => {
    res.send('wedplan webpage');
});

app.get('/users', async(req, res)=> {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})

app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});