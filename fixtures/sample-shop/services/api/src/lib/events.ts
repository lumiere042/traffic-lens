import amqp from 'amqplib';

let channel: amqp.Channel;
export async function publishOrderPlaced(order: { id: number; userId: number }) {
  if (!channel) {
    const conn = await amqp.connect(process.env.AMQP_URL!);
    channel = await conn.createChannel();
    await channel.assertQueue('order.placed');
  }
  channel.sendToQueue('order.placed', Buffer.from(JSON.stringify(order)));
}
