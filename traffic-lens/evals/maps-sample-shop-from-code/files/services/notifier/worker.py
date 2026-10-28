import json
import os

import pika
import requests
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

API_URL = os.environ["API_URL"]
sg = SendGridAPIClient(os.environ["SENDGRID_API_KEY"])


def on_order_placed(ch, method, properties, body):
    order = json.loads(body)
    sg.send(Mail(from_email="shop@example.com", to_emails="customer@example.com",
                 subject=f"Order {order['id']} confirmed", html_content="Thanks!"))
    requests.post(f"{API_URL}/internal/orders/{order['id']}/notified", timeout=5)
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    conn = pika.BlockingConnection(pika.URLParameters(os.environ["AMQP_URL"]))
    channel = conn.channel()
    channel.queue_declare(queue="order.placed")
    channel.basic_consume(queue="order.placed", on_message_callback=on_order_placed)
    channel.start_consuming()


if __name__ == "__main__":
    main()
